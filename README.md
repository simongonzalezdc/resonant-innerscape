# Innerscape — ResonantOS add-on

**Local-only by construction.** This add-on exposes [Innerscape](https://github.com/KyaniteLabs/Innerscape)'s agent surface — the project brief, the module map, and bounded reflective planning prompts — to ResonantOS agents as a private service on your machine. It contains **zero personal data**: no journal entries, no emotional check-ins, no sleep logs. It requests **zero capabilities** (the manifest's `requestedCapabilities` is empty), persists nothing, and never sends anything anywhere. Your inner life stays yours.

## What it is — and honestly is not

Innerscape (the "personal growth OS") has three declared agent surfaces: a CLI, an MCP server, and a skill. This add-on wraps the **CLI module** — three pure, stateless functions:

- `innerscape.brief` — the project brief: identity, summary, the five modules (Mind, Flow, Body, Hub, Trade), and the support guardrail ("do not diagnose, moralize, or automate major life decisions").
- `innerscape.modules` — the module map and how agents should use each module without overstepping.
- `innerscape.plan` — a bounded reflective planning prompt for a focus/energy/horizon. It returns prompt **text**; it never plans for you.

What is **not** here, by construction: Innerscape's data-bearing surfaces. The Fastify/Prisma/PostgreSQL backend (72 endpoints over journaling, emotional check-ins, habits, sleep logs), the Expo mobile app, and the MCP stdio loop are not vendored and not reachable through this service. The vendored CLI module imports only `node:` builtins and performs no I/O — pinned by test.

## Privacy properties (all test-pinned)

- **Zero capabilities requested.** Nothing to grant, nothing to revoke. The service binds loopback and calls an in-process pure function.
- **Zero persistence.** No `var/`, no config files, no logs on disk. Requests are answered and forgotten.
- **Zero egress.** No `fetch`, no outbound sockets, no subprocesses anywhere in the service layer. The only network event in the process is the loopback `listen`.
- **Home-path redaction** on every outbound body as defense in depth.
- **Personal-data scan**: the test suite scans the whole tree for emails, phone numbers, home paths, secret-shaped strings, and personal names — the only allowed name is the upstream MIT copyright attribution inside `vendor/innerscape/LICENSE`.

## Running it

Requires Node >= 22 (standard library only; the vendored upstream CLI is imported in-process, no `npm install`, no subprocess).

    node server.mjs            # listens on http://127.0.0.1:4895 (the manifest entrypoint)

    curl -s http://127.0.0.1:4895/health
    curl -s -X POST http://127.0.0.1:4895/ -H 'Content-Type: application/json' \
      -d '{"method":"innerscape.brief"}'
    curl -s -X POST http://127.0.0.1:4895/ -H 'Content-Type: application/json' \
      -d '{"method":"innerscape.plan","params":{"focus":"weekly review","energy":"low","horizon":"week"}}'

Environment (dev overrides only — the manifest declares the contract): `INNERSCAPE_PORT` (default 4895), `INNERSCAPE_REQUEST_TIMEOUT_MS` (default 30000, bounded to 1000..300000). Both exit 78 on invalid values. The service reads no credentials and accepts none as request fields.

Hardening (the epoch/stack-bench sibling pattern): JSON object envelopes of 1..65536 bytes, no unknown fields anywhere, string caps (focus 256, energy/horizon 64), control characters refused, oversized bodies answered 413 + connection close, lying Content-Length answered 408 + close (an explicit body-receipt deadline — Node's own `requestTimeout` does not fire for stalled bodies), chunked transfer-encoding refused, bind conflicts exit with code 78.

## Tests

    node --test tests/server.test.mjs                      # wrapper suite
    sh run-validator-check.sh <path-to-2.0.0-alpha-clone>  # manifest vs the real validator

`vendor/` is hash-pinned to the upstream **committed HEAD** (`git show HEAD:<path>`, never the working tree); a test fails loudly on any drift and re-verifies byte-identity against the local upstream checkout. The vendor manifest records upstream dirty paths that were deliberately *not* vendored.

## License

MIT — see LICENSE. The vendored Innerscape agent CLI is MIT, KyaniteLabs (see `vendor/innerscape/LICENSE` and NOTICE).
