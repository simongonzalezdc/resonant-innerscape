// addon.innerscape wrapper tests.
//
// Runner: node's built-in test runner (the service is Node with exported
// testable functions — the adapted equivalent of the python-unittest sibling
// suites).
//
// Run:  node --test tests/          (from the add-on root)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADDON_ID,
  ADDON_VERSION,
  COMMANDS,
  MAX_BODY,
  buildServer,
  redact,
  runCommand,
  statusPayload,
  validateParams,
} from "../server.mjs";
import { moduleMap, planningPrompt, projectBrief } from "../vendor/innerscape/tools/innerscape-cli.mjs";

const ADDON_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UPSTREAM = path.join(os.homedir(), "workspaces/kyanite-labs/Innerscape");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ADDON_ROOT, "VENDOR-MANIFEST.json"), "utf8"));

// -- helpers -----------------------------------------------------------------

async function listenEphemeral() {
  const server = buildServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, port };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function get(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: res.status, body: await res.json() };
}

async function post(port, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// Raw-socket request for framing probes: returns the full response text and
// whether the server closed the connection.
function rawSend(port, raw, { timeoutMs = 8000, settleMs = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = "";
    let closed = false;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve({ received, closed });
      socket.destroy();
    };
    socket.setTimeout(timeoutMs, done);
    socket.on("data", (d) => {
      received += d.toString();
      if (closed || !received.includes("\r\n\r\n")) return;
      const length = Number(/Content-Length: (\d+)/i.exec(received)?.[1] ?? NaN);
      if (Number.isNaN(length)) return;
      const bodyStart = received.indexOf("\r\n\r\n") + 4;
      if (received.length - bodyStart >= length) {
        setTimeout(done, settleMs); // a beat to observe an explicit close
      }
    });
    socket.on("close", () => {
      closed = true;
      done();
    });
    socket.on("error", (err) => {
      if (!settled) reject(err);
    });
    socket.on("connect", () => socket.write(raw));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Spawns server.mjs as a child. Resolves once the child either exits (bind
// failure, bad env) or answers / with a 2xx.
function spawnService(env, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
      env: { ...process.env, ...env, INNERSCAPE_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    (async () => {
      for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) return resolve({ child, stderr });
        try {
          // abort quickly: the port may be held by a non-HTTP blocker that
          // accepts but never answers, which would stall an unbounded fetch
          const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) });
          if (res.ok) return resolve({ child, stderr });
        } catch { /* not up yet (or probe aborted) */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      reject(new Error(`service did not come up on ${port}\n${stderr}`));
    })();
  });
}

// -- vendor hash pin -----------------------------------------------------------

describe("vendor hash pin", () => {
  it("re-hashes every manifest entry identically", () => {
    assert.equal(MANIFEST.files.length, 4, "vendored file set changed — re-pin deliberately");
    for (const f of MANIFEST.files) {
      const buf = fs.readFileSync(path.join(ADDON_ROOT, f.path));
      assert.equal(buf.length, f.bytes, `byte drift: ${f.path}`);
      assert.equal(createHash("sha256").update(buf).digest("hex"), f.sha256, `hash drift: ${f.path}`);
    }
  });

  it("manifests every file on disk (no extras, no missing)", () => {
    const walk = (dir, acc = []) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p, acc);
        else acc.push(path.relative(ADDON_ROOT, p));
      }
      return acc;
    };
    const onDisk = new Set(walk(path.join(ADDON_ROOT, "vendor")));
    const pinned = new Set(MANIFEST.files.map((f) => f.path));
    for (const p of onDisk) assert.ok(pinned.has(p), `file on disk but not pinned: ${p}`);
    for (const p of pinned) assert.ok(onDisk.has(p), `pinned but absent: ${p}`);
  });

  it("vendored files are byte-identical to the upstream COMMITTED HEAD (not the working tree)", (t) => {
    if (!fs.existsSync(UPSTREAM)) { t.skip("upstream checkout not present"); return; }
    for (const f of MANIFEST.files) {
      const upstreamRel = f.path.replace(/^vendor\/innerscape\//, "");
      const headBytes = execFileSync("git", ["-C", UPSTREAM, "show", `HEAD:${upstreamRel}`]);
      const ours = fs.readFileSync(path.join(ADDON_ROOT, f.path));
      assert.ok(ours.equals(headBytes), `vendor drift vs upstream HEAD ${MANIFEST.upstream.commit.slice(0, 12)}: ${f.path}`);
    }
  });

  it("pins the expected upstream identity", () => {
    assert.equal(MANIFEST.upstream.version, "0.1.0");
    assert.equal(MANIFEST.upstream.license, "MIT");
    assert.match(MANIFEST.upstream.repo, /KyaniteLabs\/Innerscape/);
    assert.match(MANIFEST.upstream.commit, /^[0-9a-f]{40}$/);
  });

  it("vendored modules import only node: builtins (no dependency closure, no network libs)", () => {
    for (const f of MANIFEST.files) {
      if (!f.path.endsWith(".mjs")) continue;
      const src = fs.readFileSync(path.join(ADDON_ROOT, f.path), "utf8");
      const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^"']*["']([^"']+)["']/g)].map((m) => m[1]);
      assert.ok(specs.length > 0, `no imports found in ${f.path}`);
      for (const spec of specs) {
        assert.ok(
          spec.startsWith("node:") || spec.startsWith("."),
          `${f.path} imports non-builtin specifier: ${spec}`,
        );
      }
    }
  });
});

// -- surface pin ---------------------------------------------------------------

describe("surface pin", () => {
  it("vendored CLI exports exactly the three-function agent surface", () => {
    assert.equal(typeof projectBrief, "function");
    assert.equal(typeof moduleMap, "function");
    assert.equal(typeof planningPrompt, "function");
  });

  it("the module map is exactly the five upstream modules", () => {
    const names = moduleMap().modules.map((m) => m.name);
    assert.deepEqual(names, ["Mind", "Flow", "Body", "Hub", "Trade"]);
  });

  it("the service imports vendored functions in-process and never spawns anything", () => {
    const src = fs.readFileSync(path.join(ADDON_ROOT, "server.mjs"), "utf8");
    assert.ok(!src.includes("child_process"), "server must not import child_process");
    assert.ok(!src.includes("spawn("), "server must not spawn");
    assert.ok(!src.includes("node:net"), "server must not import node:net (no outbound sockets)");
    assert.ok(!src.includes("fetch("), "server must not fetch");
    assert.ok(src.includes('from "./vendor/innerscape/tools/innerscape-cli.mjs"'), "server must import the vendored CLI in-process");
    assert.ok(src.includes("projectBrief()") && src.includes("moduleMap()") && src.includes("planningPrompt("), "server must call the vendored functions directly");
  });

  it("exposed commands are exactly the manifest-declared four", () => {
    assert.deepEqual([...COMMANDS], ["innerscape.status", "innerscape.brief", "innerscape.modules", "innerscape.plan"]);
    const addon = JSON.parse(fs.readFileSync(path.join(ADDON_ROOT, "addon.json"), "utf8"));
    assert.deepEqual(addon.tools.map((t) => t.name).sort(), [...COMMANDS].sort());
    assert.deepEqual(addon.requestedCapabilities, [], "the privacy story IS the zero-capability manifest");
    for (const tool of addon.tools) assert.deepEqual(tool.requiredCapabilities, []);
  });
});

// -- status / health -----------------------------------------------------------

describe("status and health", () => {
  it("GET / and GET /health and innerscape.status all report the pinned upstream", async () => {
    const { server, port } = await listenEphemeral();
    try {
      for (const pathname of ["/", "/health"]) {
        const { status, body } = await get(port, pathname);
        assert.equal(status, 200, pathname);
        assert.equal(body.ok, true);
        assert.equal(body.addon, ADDON_ID);
        assert.match(body.upstream, /^innerscape@0\.1\.0$/);
        assert.deepEqual(body.commands, COMMANDS);
      }
      const { status, body } = await post(port, { method: "innerscape.status" });
      assert.equal(status, 200);
      assert.equal(body.ok, true);
    } finally {
      await closeServer(server);
    }
  });
});

// -- real surface round-trips ---------------------------------------------------

describe("real surface round-trips", () => {
  const state = {};
  before(async () => {
    const { server, port } = await listenEphemeral();
    state.server = server;
    state.port = port;
    state.call = (method, params) => post(port, { method, ...(params !== undefined ? { params } : {}) });
  });
  after(async () => {
    await closeServer(state.server);
  });

  it("innerscape.brief returns the upstream project brief", async () => {
    const { status, body } = await state.call("innerscape.brief");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.command, "innerscape.brief");
    assert.equal(body.data.name, "Innerscape");
    assert.match(body.data.summary, /Personal growth OS/);
    assert.match(body.data.guardrail, /Do not diagnose/);
    assert.deepEqual(Object.keys(body.data.surfaces).sort(), ["backend", "cli", "mcp", "mobile", "skill"]);
    assert.equal(body.data.modules.length, 5);
    // identical to calling the vendored function directly
    assert.deepEqual(body.data, projectBrief());
  });

  it("innerscape.modules returns the upstream module map", async () => {
    const { status, body } = await state.call("innerscape.modules");
    assert.equal(status, 200);
    assert.deepEqual(body.data, moduleMap());
    const mind = body.data.modules.find((m) => m.name === "Mind");
    assert.match(mind.scope, /journal entries, emotional check-ins/);
  });

  it("innerscape.plan echoes focus/energy/horizon and returns the bounded prompt", async () => {
    const { status, body } = await state.call("innerscape.plan", { focus: "weekly review", energy: "low", horizon: "week" });
    assert.equal(status, 200);
    assert.equal(body.data.focus, "weekly review");
    assert.equal(body.data.energy, "low");
    assert.equal(body.data.horizon, "week");
    assert.equal(body.data.prompt.length, 4);
    assert.ok(body.data.prompt.some((line) => line.includes("weekly review")));
    assert.ok(body.data.prompt.some((line) => line.includes("low")));
    assert.deepEqual(body.data, planningPrompt({ focus: "weekly review", energy: "low", horizon: "week" }));
  });

  it("innerscape.plan defaults match upstream (general / unknown / today)", async () => {
    const { status, body } = await state.call("innerscape.plan");
    assert.equal(status, 200);
    assert.deepEqual(body.data, planningPrompt({}));
    assert.equal(body.data.focus, "general");
    assert.equal(body.data.energy, "unknown");
    assert.equal(body.data.horizon, "today");
  });

  it("innerscape.status via runCommand matches the HTTP payload", () => {
    const outcome = runCommand("innerscape.status", undefined);
    assert.equal(outcome.code, 200);
    assert.deepEqual(outcome.payload, { ok: true, command: "innerscape.status", data: statusPayload() });
  });
});

// -- strict service params (stricter than upstream) ------------------------------

describe("strict params", () => {
  it("unknown param fields rejected -> 400", async () => {
    const state = {};
    const { server, port } = await listenEphemeral();
    state.server = server;
    try {
      const res = await post(port, { method: "innerscape.plan", params: { focus: "x", sneaky: 1 } });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /unknown field: sneaky/);
    } finally {
      await closeServer(server);
    }
  });

  it("oversized strings rejected -> 400 (cap 256/64/64)", async () => {
    assert.match(validateParams("innerscape.plan", { focus: "x".repeat(257) }), /at most 256/);
    assert.match(validateParams("innerscape.plan", { energy: "x".repeat(65) }), /at most 64/);
    assert.match(validateParams("innerscape.plan", { horizon: "x".repeat(65) }), /at most 64/);
    assert.equal(validateParams("innerscape.plan", { focus: "x".repeat(256) }), null);
  });

  it("wrong types rejected: numbers/arrays/booleans where strings belong", async () => {
    assert.match(validateParams("innerscape.plan", { focus: 42 }), /must be a string/);
    assert.match(validateParams("innerscape.plan", { focus: ["a"] }), /must be a string/);
    assert.match(validateParams("innerscape.plan", { energy: true }), /must be a string/);
    assert.match(validateParams("innerscape.plan", "string"), /params must be an object/);
  });

  it("brief/modules accept only empty params", () => {
    assert.equal(validateParams("innerscape.brief", {}), null);
    assert.equal(validateParams("innerscape.brief", undefined), null);
    assert.match(validateParams("innerscape.brief", { focus: "x" }), /unknown field: focus/);
    assert.match(validateParams("innerscape.modules", { a: 1 }), /unknown field: a/);
  });

  it("non-object params -> 400 over HTTP", async () => {
    const { server, port } = await listenEphemeral();
    try {
      for (const params of ["string", 42, [], true]) {
        const { status } = await post(port, { method: "innerscape.plan", params });
        assert.equal(status, 400, `params=${JSON.stringify(params)}`);
      }
    } finally {
      await closeServer(server);
    }
  });
});

// -- adversarial matrix -----------------------------------------------------------

describe("adversarial matrix", () => {
  const state = {};
  before(async () => {
    const { server, port } = await listenEphemeral();
    state.server = server;
    state.port = port;
    state.call = (method, params) => post(port, { method, ...(params !== undefined ? { params } : {}) });
  });
  after(async () => {
    await closeServer(state.server);
  });

  it("unknown command over HTTP is an unknown method -> 404 (sibling contract)", async () => {
    const { status, body } = await state.call("innerscape.execute", { order: "delete everything" });
    assert.equal(status, 404);
    assert.match(body.error, /unknown method/);
  });

  it("runCommand still refuses unknown commands with the allowed list (defense in depth)", () => {
    const outcome = runCommand("innerscape.execute", { order: "delete everything" });
    assert.equal(outcome.code, 400);
    assert.match(outcome.payload.error, /unknown command/);
    assert.deepEqual(outcome.payload.allowed, COMMANDS);
  });

  it("unknown method -> 404", async () => {
    const { status } = await post(state.port, { method: "innerscape.nothing" });
    assert.equal(status, 404);
  });

  it("unknown envelope field -> 400", async () => {
    const res = await fetch(`http://127.0.0.1:${state.port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "innerscape.status", extra: 1 }),
    });
    assert.equal(res.status, 400);
  });

  it("control characters in any parameter string -> 400", async () => {
    for (const [field, value] of [["focus", "week\n; rm -rf /"], ["energy", "lo\u0001w"], ["horizon", "tod\u007fay"]]) {
      const { status } = await state.call("innerscape.plan", { [field]: value });
      assert.equal(status, 400, `${field} control char`);
    }
    // deep: nested inside the envelope's params via runCommand path
    const outcome = runCommand("innerscape.plan", { focus: "a\u0000b" });
    assert.equal(outcome.code, 400);
  });

  it("control character in method string -> 400", async () => {
    const { status } = await post(state.port, { method: "innerscape.\u0001status" });
    assert.equal(status, 400);
  });

  it("oversized body -> 413 + connection close (raw)", async () => {
    const big = JSON.stringify({ method: "innerscape.plan", params: { focus: "x".repeat(MAX_BODY) } });
    assert.ok(Buffer.byteLength(big) > MAX_BODY);
    const { received, closed } = await rawSend(state.port, `POST / HTTP/1.1\r\nHost: t\r\nContent-Length: ${Buffer.byteLength(big)}\r\n\r\n${big}`);
    assert.match(received, /^HTTP\/1\.1 413/);
    assert.match(received, /Connection: close/i);
    assert.ok(closed, "server must close after 413");
  });

  it("content-length over limit declared up front -> 413 (raw)", async () => {
    const { received, closed } = await rawSend(state.port, `POST / HTTP/1.1\r\nHost: t\r\nContent-Length: ${MAX_BODY + 1}\r\n\r\n`);
    assert.match(received, /^HTTP\/1\.1 413/);
    assert.ok(closed);
  });

  it("chunked transfer-encoding -> 400 (raw)", async () => {
    const body = JSON.stringify({ method: "innerscape.status" });
    const raw = `POST / HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`;
    const { received, closed } = await rawSend(state.port, raw);
    assert.match(received, /^HTTP\/1\.1 400/);
    assert.ok(closed);
  });

  it("missing content-length -> 400 (raw)", async () => {
    const { received } = await rawSend(state.port, "POST / HTTP/1.1\r\nHost: t\r\n\r\n");
    assert.match(received, /^HTTP\/1\.1 400/);
  });

  it("garbage body -> 400", async () => {
    const res = await fetch(`http://127.0.0.1:${state.port}/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(res.status, 400);
  });

  it("non-object envelopes -> 400; wrong verbs/paths -> 404/405", async () => {
    for (const raw of [JSON.stringify(["array"]), JSON.stringify("str"), JSON.stringify(42)]) {
      const res = await fetch(`http://127.0.0.1:${state.port}/`, { method: "POST", body: raw });
      assert.equal(res.status, 400, raw);
    }
    assert.equal((await fetch(`http://127.0.0.1:${state.port}/nope`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${state.port}/`, { method: "DELETE" })).status, 405);
    assert.equal((await post(state.port, { method: "innerscape.status" })).status, 200);
  });

  it("lying content-length -> 408 + close within the deadline (subprocess)", async () => {
    const port2 = await freePort();
    const { child } = await spawnService({ INNERSCAPE_REQUEST_TIMEOUT_MS: "1000" }, port2);
    try {
      const t0 = Date.now();
      const { received, closed } = await rawSend(port2, "POST / HTTP/1.1\r\nHost: t\r\nContent-Length: 2000\r\n\r\n{", { timeoutMs: 8000 });
      const elapsed = Date.now() - t0;
      assert.match(received, /^HTTP\/1\.1 408/, `expected 408, got: ${received.slice(0, 60)}`);
      assert.ok(closed, "socket must close after 408");
      assert.ok(elapsed < 6000, `408 took too long: ${elapsed}ms`);
    } finally {
      child.kill();
    }
  });

  it("20-request flood all answered (concurrency)", async () => {
    const requests = [];
    for (let i = 0; i < 20; i++) {
      requests.push(i % 4 === 0
        ? post(state.port, { method: "innerscape.status" })
        : i % 4 === 1
          ? state.call("innerscape.plan", { focus: `synthetic-${i}`, energy: "low" })
          : i % 4 === 2
            ? state.call("innerscape.brief")
            : state.call("innerscape.modules"));
    }
    const results = await Promise.all(requests);
    for (const r of results) assert.equal(r.status, 200, `unexpected status ${r.status}`);
    // correct per-request answers under concurrency (no cross-talk)
    const plan = results[1];
    assert.equal(plan.body.data.focus, "synthetic-1");
  });

  it("no $HOME path ever appears in a response", async () => {
    const home = os.homedir();
    const usersNeedle = path.sep + "Users" + path.sep; // built at runtime so this file stays clean
    const probes = [
      await get(state.port, "/health"),
      await post(state.port, { method: "innerscape.status" }),
      await state.call("innerscape.brief"),
      await state.call("innerscape.plan", { focus: "weekly review" }),
      await state.call("innerscape.no-such-command"),
    ];
    for (const { body } of probes) {
      const text = JSON.stringify(body);
      assert.ok(!text.includes(home), "home path leaked in response");
      assert.ok(!text.includes(usersNeedle), "Users path leaked in response");
    }
    assert.equal(redact(`${home}/journal/x.md`), "~/journal/x.md");
  });
});

// -- lifecycle: bind conflict and env validation ---------------------------------

describe("service lifecycle", () => {
  it("bind conflict exits 78", async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address();
    try {
      const { child, stderr } = await spawnService({}, port);
      // the child may already have exited (that is the expected 78 path)
      const code = child.exitCode !== null
        ? child.exitCode
        : await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
      assert.equal(code, 78, `expected exit 78, stderr: ${stderr}`);
    } finally {
      blocker.close();
    }
  });

  it("invalid INNERSCAPE_PORT -> exit 78", async () => {
    const child = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
      env: { ...process.env, INNERSCAPE_PORT: "not-a-port" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 78);
  });

  it("invalid INNERSCAPE_REQUEST_TIMEOUT_MS -> exit 78", async () => {
    const child = spawn(process.execPath, [path.join(ADDON_ROOT, "server.mjs")], {
      env: { ...process.env, INNERSCAPE_REQUEST_TIMEOUT_MS: "50" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 78);
  });
});

// -- tree hygiene + privacy scan ---------------------------------------------------

describe("tree hygiene and privacy scan", () => {
  // The add-on must contain zero real personal data. The ONLY intentional
  // occurrence of a personal name is the upstream MIT copyright attribution
  // inside vendor/innerscape/LICENSE (legally required to keep; it is public
  // upstream metadata, not journaling data). The needle is assembled at
  // runtime so this file does not match itself.
  const NAME_ALLOWLIST = new Set(["vendor/innerscape/LICENSE"]);
  const NAME_NEEDLE = ["Si", "mon"].join("");
  const SECRET_RES = [
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /sk-[A-Za-z0-9-]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
  ];
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const PHONE_RE = /(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/;
  const ISO_BIRTH_RE = /(19|20)\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T/;

  function walk(dir, acc = []) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === ".git" || name === "node_modules") continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p, acc);
      else acc.push(p);
    }
    return acc;
  }

  it("no home paths, no secret-shaped strings, no emails, no phone numbers anywhere in the tree", () => {
    const needle = Buffer.from(path.sep + "Users" + path.sep);
    const homeBuf = Buffer.from(os.homedir());
    for (const file of walk(ADDON_ROOT)) {
      const rel = path.relative(ADDON_ROOT, file);
      const content = fs.readFileSync(file);
      assert.ok(!content.includes(needle), `home path leaked in ${rel}`);
      assert.ok(!content.includes(homeBuf), `homedir leaked in ${rel}`);
      const text = /\.(mjs|json|md|sh|js|py)$/.test(file) ? content.toString() : "";
      for (const re of SECRET_RES) assert.ok(!re.test(text), `secret-shaped string in ${rel}`);
      assert.ok(!EMAIL_RE.test(text), `email-shaped string in ${rel}`);
      assert.ok(!PHONE_RE.test(text), `phone-shaped string in ${rel}`);
      assert.ok(!ISO_BIRTH_RE.test(text), `birth-timestamp-shaped string in ${rel}`);
    }
  });

  it("personal names appear only in the upstream license attribution", () => {
    for (const file of walk(ADDON_ROOT)) {
      const rel = path.relative(ADDON_ROOT, file);
      if (!/\.(mjs|json|md|sh|js|py|txt)$/.test(file)) continue;
      const mentions = fs.readFileSync(file, "utf8").includes(NAME_NEEDLE);
      if (NAME_ALLOWLIST.has(rel)) {
        assert.ok(mentions, `expected the upstream attribution in ${rel}`);
      } else {
        assert.ok(!mentions, `personal name outside license attribution in ${rel}`);
      }
    }
  });

  it("the vendored agent surface carries no journal/emotional data classes", () => {
    // The exposed module is static self-description: module names, scopes,
    // agent-use prose, guardrails. Nothing keyed to a person, no entry-like
    // payloads, no mood/metric records.
    for (const rel of MANIFEST.files.map((f) => f.path)) {
      if (!rel.endsWith("innerscape-cli.mjs")) continue;
      const src = fs.readFileSync(path.join(ADDON_ROOT, rel), "utf8");
      assert.ok(!/new Date\(|Date\.now\(|process\.env|readFile|writeFile|createServer|fetch\(|connect\(/.test(src), `vendored CLI gained I/O: ${rel}`);
    }
    // and the service itself persists nothing
    const serverSrc = fs.readFileSync(path.join(ADDON_ROOT, "server.mjs"), "utf8");
    assert.ok(!serverSrc.includes("writeFile") && !serverSrc.includes("appendFile") && !serverSrc.includes("openSync"), "service must not write files");
    assert.ok(!fs.existsSync(path.join(ADDON_ROOT, "var")), "stateless add-on must not ship a var/ data dir");
  });

  it("manifest is internally honest: zero capabilities, local-only entrypoint", () => {
    const addon = JSON.parse(fs.readFileSync(path.join(ADDON_ROOT, "addon.json"), "utf8"));
    assert.equal(addon.requestedCapabilities.length, 0);
    assert.equal(addon.providerRequirements.supportsPrivateCredentials, false);
    assert.deepEqual(addon.archiveIntegration.readScopes, []);
    assert.deepEqual(addon.archiveIntegration.intakeWriteScopes, []);
    assert.match(addon.service.entrypoint, /^http:\/\/127\.0\.0\.1:4895$/);
  });
});
