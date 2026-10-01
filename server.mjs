#!/usr/bin/env node
// addon.innerscape local-service entry (http-json on 127.0.0.1:4895).
//
// ResonantOS add-on contract: protocol http-json, healthCommand innerscape.status.
// Node >= 22 standard library only (node:http). NO subprocesses, NO shell, NO
// secrets, NO persistence, NO outbound network. The vendored Innerscape agent
// CLI (tools/innerscape-cli.mjs) is imported IN-PROCESS and its three exported
// functions — projectBrief(), moduleMap(), planningPrompt() — are called
// directly. Those functions are pure: they touch no filesystem, no database,
// no network, and they carry no personal data. Innerscape's data-bearing
// surfaces (the Fastify/Prisma/PostgreSQL backend, the Expo app) are NOT
// vendored and NOT reachable through this service by construction.
//
// Framing mirrors the epoch/stack-bench sibling shims: JSON
// {"method","params"} envelope, body 1..65536 bytes, oversized -> 413 + close,
// lying Content-Length -> 408 (explicit body-receipt deadline) + close,
// chunked -> 400, control chars -> 400, bind conflict -> exit 78. Every
// outbound body passes through home-path redaction (nothing is persisted, so
// this is defense in depth, matching the sibling pattern).
//
// All Innerscape agent commands are <1 ms pure functions, so there are no job
// semantics: every call answers synchronously.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { moduleMap, planningPrompt, projectBrief } from "./vendor/innerscape/tools/innerscape-cli.mjs";

const ADDON_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ADDON_ID = "addon.innerscape";
const ADDON_VERSION = "0.1.0";
const PINNED = JSON.parse(readFileSync(path.join(ADDON_ROOT, "vendor/innerscape/package.json"), "utf8"));
const UPSTREAM_LABEL = `innerscape@${PINNED.version}`;

const PORT = parseDevPort(); // dev override only; the manifest entrypoint (4895) is the contract
const REQUEST_TIMEOUT_MS = parseDevTimeout(); // default 30000: a lying Content-Length must not pin a socket
const MAX_BODY = 64 * 1024;
const MAX_DEPTH = 4;

const COMMANDS = Object.freeze(["innerscape.status", "innerscape.brief", "innerscape.modules", "innerscape.plan"]);

// -- strict service-level param schemas (stricter than upstream, which accepts
//    any string; upstream semantics are preserved inside the cap) ------------

const SCHEMAS = {
  "innerscape.status": { props: {}, req: [] },
  "innerscape.brief": { props: {}, req: [] },
  "innerscape.modules": { props: {}, req: [] },
  "innerscape.plan": {
    props: {
      focus: { type: "string", maxLen: 256 },
      energy: { type: "string", maxLen: 64 },
      horizon: { type: "string", maxLen: 64 },
    },
    req: [],
  },
};

function parseDevPort() {
  const raw = process.env.INNERSCAPE_PORT;
  if (raw === undefined) return 4895;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    process.stderr.write("innerscape-service: INNERSCAPE_PORT must be an integer in 1..65535\n");
    process.exit(78);
  }
  return n;
}

function parseDevTimeout() {
  const raw = process.env.INNERSCAPE_REQUEST_TIMEOUT_MS;
  if (raw === undefined) return 30000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > 300000) {
    process.stderr.write("innerscape-service: INNERSCAPE_REQUEST_TIMEOUT_MS must be an integer in 1000..300000\n");
    process.exit(78);
  }
  return n;
}

function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// Deep control-char scan of every string in a parsed JSON value.
function scanControlChars(value) {
  if (typeof value === "string") return hasControlChars(value);
  if (Array.isArray(value)) return value.some(scanControlChars);
  if (value !== null && typeof value === "object") return Object.values(value).some(scanControlChars);
  return false;
}

function checkString(value, spec) {
  if (typeof value !== "string") return `must be a string`;
  if (value.length > spec.maxLen) return `must be at most ${spec.maxLen} characters`;
  if (hasControlChars(value)) return "contains control characters";
  return null;
}

// Returns an error string or null. Enforces: no unknown fields, string caps,
// control characters, depth cap.
function validateAgainstSpec(value, spec, where, depth) {
  if (depth > MAX_DEPTH) return `${where} is nested too deeply`;
  switch (spec.type) {
    case "string":
      return checkString(value, spec) && `${where} ${checkString(value, spec)}`;
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} must be an object`;
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(spec.props, key)) return `${where} has unknown field: ${key}`;
        const err = validateAgainstSpec(value[key], spec.props[key], `${where}.${key}`, depth + 1);
        if (err) return err;
      }
      for (const key of spec.req ?? []) {
        if (!Object.hasOwn(value, key)) return `${where} is missing required field: ${key}`;
      }
      return null;
    }
    default:
      return `${where} has an unsupported schema`;
  }
}

function validateParams(command, params) {
  const spec = SCHEMAS[command];
  if (!spec) return `unknown command: ${command}`;
  if (params === undefined || params === null) return null; // upstream defaults apply downstream
  if (typeof params !== "object" || Array.isArray(params)) return "params must be an object";
  return validateAgainstSpec(params, { type: "object", props: spec.props, req: spec.req }, "params", 1);
}

function redact(text) {
  const home = os.homedir();
  return home && home !== "/" && home !== "~" ? text.split(home).join("~") : text;
}

function statusPayload() {
  return {
    ok: true,
    addon: ADDON_ID,
    version: ADDON_VERSION,
    upstream: UPSTREAM_LABEL,
    commands: COMMANDS,
  };
}

function runCommand(command, params) {
  if (!COMMANDS.includes(command)) {
    return { code: 400, payload: { ok: false, command, error: `unknown command: ${redact(String(command))}`, allowed: COMMANDS } };
  }
  if (scanControlChars(params)) {
    return { code: 400, payload: { ok: false, command, error: "params contain control characters" } };
  }
  const paramErr = validateParams(command, params);
  if (paramErr) return { code: 400, payload: { ok: false, command, error: paramErr } };
  let data;
  try {
    if (command === "innerscape.status") data = statusPayload();
    else if (command === "innerscape.brief") data = projectBrief();
    else if (command === "innerscape.modules") data = moduleMap();
    else if (command === "innerscape.plan") {
      const p = params ?? {};
      data = planningPrompt({
        ...(p.focus !== undefined ? { focus: p.focus } : {}),
        ...(p.energy !== undefined ? { energy: p.energy } : {}),
        ...(p.horizon !== undefined ? { horizon: p.horizon } : {}),
      });
    }
  } catch (err) {
    process.stderr.write(`innerscape-service: handler error for ${command}: ${err instanceof Error ? err.name : "non-error"}\n`);
    return { code: 500, payload: { ok: false, command, error: "internal command error" } };
  }
  return { code: 200, payload: { ok: true, command, data } };
}

function buildServer() {
  const server = createServer((req, res) => {
    const started = process.hrtime.bigint();
    const finish = (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      process.stderr.write(`innerscape-service: ${req.method} ${req.url} ${code} ${ms.toFixed(1)}ms\n`);
    };
    if (req.method === "GET") {
      if (req.url === "/" || req.url === "/health") {
        reply(res, 200, statusPayload());
        finish(200);
      } else {
        reply(res, 404, { error: "not found" }, true);
        finish(404);
      }
      return;
    }
    if (req.method !== "POST") {
      reply(res, 405, { error: "method not allowed" }, true);
      finish(405);
      return;
    }
    handlePost(req, res, finish);
  });
  // Header-phase stall safety (belt and suspenders; the body deadline in
  // handlePost is the actual lying-Content-Length enforcement).
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.max(500, Math.min(10000, Math.floor(REQUEST_TIMEOUT_MS / 2)));
  server.keepAliveTimeout = 5000;
  return server;
}

function reply(res, code, payload, close = false) {
  const body = Buffer.from(redact(JSON.stringify(payload)), "utf8");
  const headers = { "Content-Type": "application/json", "Content-Length": body.length };
  if (close) headers["Connection"] = "close";
  res.writeHead(code, headers);
  res.end(body, () => {
    // never leave an undrained request body on a keep-alive socket — but if the
    // request has NOT fully arrived (e.g. a 413 was sent mid-stream), destroying
    // now would RST the connection and swallow this response on the client; a
    // drain/grace path in handlePost owns the socket in that case.
    if (close) {
      if (res.req?.complete ?? true) res.socket?.destroy();
      else res.socket?.end();
    }
  });
}

function handlePost(req, res, finish) {
  if (req.url !== "/") {
    reply(res, 404, { error: "not found" }, true);
    finish(404);
    return;
  }
  if (req.headers["transfer-encoding"]) {
    reply(res, 400, { error: "transfer-encoding is not accepted; send a fixed Content-Length" }, true);
    finish(400);
    return;
  }
  const raw = req.headers["content-length"];
  if (raw === undefined) {
    reply(res, 400, { error: "content-length is required (1..65536 bytes)" }, true);
    finish(400);
    return;
  }
  const length = Number(raw);
  if (!Number.isInteger(length)) {
    reply(res, 400, { error: "bad content-length" }, true);
    finish(400);
    return;
  }
  if (length <= 0 || length > MAX_BODY) {
    reply(res, 413, { error: "body must be 1..65536 bytes" }, true);
    finish(413);
    return;
  }
  const chunks = [];
  let received = 0;
  let settled = false;
  let bodyTimer = null;
  const fail = (code, message) => {
    if (settled) return;
    settled = true;
    reply(res, code, { error: message }, true);
    finish(code);
  };
  // A lying Content-Length must never pin a socket: Node's server.requestTimeout
  // does NOT answer 408 for a stalled request BODY, so the body deadline is
  // enforced explicitly.
  const clearBodyTimer = () => {
    if (bodyTimer !== null) {
      clearTimeout(bodyTimer);
      bodyTimer = null;
    }
  };
  bodyTimer = setTimeout(() => {
    fail(408, "request was not received in full within the timeout; check Content-Length");
  }, REQUEST_TIMEOUT_MS);
  bodyTimer.unref?.();
  req.on("data", (chunk) => {
    if (settled) {
      return;
    }
    received += chunk.length;
    if (received > MAX_BODY) {
      // Drain and discard the surplus so the RST from the eventual socket
      // destroy cannot swallow the 413 on the client side; endless senders
      // are cut off by the grace timer.
      req.resume();
      clearBodyTimer();
      const grace = setTimeout(() => res.socket?.destroy(), 5000);
      grace.unref?.();
      req.on("end", () => res.socket?.destroy());
      fail(413, "body must be 1..65536 bytes");
      return;
    }
    chunks.push(chunk);
  });
  req.on("error", () => {
    clearBodyTimer();
    settled = true; // client vanished; response is moot
    res.socket?.destroy();
  });
  req.on("close", clearBodyTimer);
  req.on("end", () => {
    clearBodyTimer();
    if (settled) return;
    settled = true;
    let envelope;
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      reply(res, 400, { error: "body must be valid JSON" }, true);
      finish(400);
      return;
    }
    dispatchEnvelope(envelope, res, finish);
  });
}

function dispatchEnvelope(envelope, res, finish) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    reply(res, 400, { error: "body must be a JSON object" }, true);
    finish(400);
    return;
  }
  for (const key of Object.keys(envelope)) {
    if (key !== "method" && key !== "params") {
      reply(res, 400, { error: `unknown field: ${key}` }, true);
      finish(400);
      return;
    }
  }
  const method = envelope.method;
  if (typeof method !== "string" || method.length > 64 || hasControlChars(method)) {
    reply(res, 400, { error: "method must be a short string" }, true);
    finish(400);
    return;
  }
  if (method === "innerscape.status") {
    reply(res, 200, statusPayload());
    finish(200);
    return;
  }
  if (method === "innerscape.brief" || method === "innerscape.modules" || method === "innerscape.plan") {
    const params = envelope.params;
    if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
      reply(res, 400, { ok: false, error: "params must be an object" });
      finish(400);
      return;
    }
    const outcome = runCommand(method, params);
    reply(res, outcome.code, outcome.payload);
    finish(outcome.code);
    return;
  }
  reply(res, 404, { error: `unknown method: ${method}` });
  finish(404);
}

async function main() {
  const server = buildServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, "127.0.0.1", resolve);
    });
  } catch (err) {
    process.stderr.write(`innerscape-service: cannot bind 127.0.0.1:${PORT} (${err.code ?? err.message}); manifest entrypoint expects this port\n`);
    process.exit(78);
  }
  process.stderr.write(`innerscape-service: ${UPSTREAM_LABEL} listening on http://127.0.0.1:${PORT} (commands: ${COMMANDS.length})\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

export { ADDON_ID, ADDON_VERSION, COMMANDS, MAX_BODY, SCHEMAS, buildServer, redact, runCommand, statusPayload, validateParams };
