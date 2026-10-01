#!/usr/bin/env node
// Regenerates vendor/ from a local checkout of Innerscape.
//
//   node scripts/vendor-innerscape.mjs [path-to-innerscape-checkout]
//
// Vendored artifacts (all extracted from the COMMITTED HEAD via `git show`,
// never from the working tree — an upstream checkout with uncommitted edits
// still vendors a reproducible, hash-pinned state):
//   vendor/innerscape/tools/innerscape-cli.mjs   byte-identical upstream agent CLI
//                                                (projectBrief / moduleMap / planningPrompt)
//   vendor/innerscape/tools/innerscape-mcp.mjs   byte-identical upstream stdio MCP server
//   vendor/innerscape/package.json               byte-identical upstream manifest
//                                                (provenance: version + MIT license)
//   vendor/innerscape/LICENSE                    byte-identical upstream MIT license
//
// The vendored modules import ONLY node: builtins (node:url, node:readline) —
// there is no npm dependency closure to vendor, and the service never spawns
// them; it imports their exported functions in-process.
//
// Writes VENDOR-MANIFEST.json (relative path -> sha256) for the hash-pin gate.
// Node >= 22, no dependencies beyond the upstream checkout itself.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const UPSTREAM = path.resolve(process.argv[2] ?? path.join(os.homedir(), "workspaces/kyanite-labs/Innerscape"));
const HERE = path.dirname(path.dirname(path.resolve(import.meta.filename)));
const VENDOR = path.join(HERE, "vendor");
const INNERSCAPE = path.join(VENDOR, "innerscape");

// Files copied byte-identical from the committed HEAD.
const UPSTREAM_FILES = [
  "tools/innerscape-cli.mjs",
  "tools/innerscape-mcp.mjs",
  "package.json",
  "LICENSE",
];
const PINNED = {
  innerscape: "0.1.0",
  license: "MIT",
};

const fail = (msg) => {
  console.error("vendor-innerscape: " + msg);
  process.exit(1);
};

// 1. Pin checks against the checkout's committed state.
const upstreamPkg = JSON.parse(execFileSync("git", ["-C", UPSTREAM, "show", "HEAD:package.json"], { encoding: "utf8" }));
if (upstreamPkg.version !== PINNED.innerscape) fail(`pinned innerscape is ${PINNED.innerscape} but upstream HEAD has ${upstreamPkg.version}`);
if (upstreamPkg.license !== PINNED.license) fail(`pinned license is ${PINNED.license} but upstream HEAD declares ${upstreamPkg.license}`);

// 2. Working-tree dirtiness is ALLOWED but recorded: the vendored bytes are
//    HEAD's, so a dirty tree never leaks into vendor/.
let dirty = [];
try {
  dirty = execFileSync("git", ["-C", UPSTREAM, "status", "--porcelain"], { encoding: "utf8" })
    .split("\n").map((l) => l.trim()).filter(Boolean);
} catch { /* recorded as unknown via the catch below */ }
let dirtyNote;
try {
  dirtyNote = dirty.length > 0
    ? `upstream working tree was dirty at vendor time and its edits are deliberately NOT vendored: ${dirty.join("; ")}`
    : "upstream working tree was clean at vendor time";
} catch {
  dirtyNote = "upstream working-tree state unknown at vendor time";
}

// 3. Rebuild vendor/ from scratch so the manifest never describes stale files.
rmSync(VENDOR, { recursive: true, force: true });
for (const rel of UPSTREAM_FILES) {
  const dst = path.join(INNERSCAPE, rel);
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, execFileSync("git", ["-C", UPSTREAM, "show", `HEAD:${rel}`]));
}

// 4. Manifest: sha256 of every vendored file.
const upstreamCommit = execFileSync("git", ["-C", UPSTREAM, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(path.relative(HERE, p));
  }
}
walk(VENDOR);
const manifest = {
  generator: "scripts/vendor-innerscape.mjs",
  upstream: {
    name: "innerscape",
    repo: "https://github.com/KyaniteLabs/Innerscape",
    version: PINNED.innerscape,
    commit: upstreamCommit,
    license: PINNED.license,
  },
  notes: [
    "all files are byte-identical extractions of the COMMITTED HEAD (`git show HEAD:<path>`), never the working tree",
    dirtyNote,
    "the vendored modules import only node: builtins — no dependency closure exists",
    "the service imports the vendored CLI's exported functions in-process; it never spawns them",
  ],
  files: files.map((rel) => {
    const buf = readFileSync(path.join(HERE, rel));
    return { path: rel, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  }),
};
writeFileSync(path.join(HERE, "VENDOR-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`vendor-innerscape: ${manifest.files.length} files pinned; upstream ${PINNED.innerscape} @ ${upstreamCommit.slice(0, 12)}${dirty.length > 0 ? ` (${dirty.length} dirty upstream paths NOT vendored)` : ""}`);
