# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm test                              # vitest run (all tests)
npm run test:watch                    # watch mode
npx vitest run tests/emitter.test.ts  # single test file
npx vitest run -t "buildPayload"      # single test by name
npm run build                         # tsup: CJS + ESM + .d.ts/.d.cts into dist/
npx tsc --noEmit                      # typecheck only (no lint tooling in this repo)
```

There is no linter. `tsc` is strict; `tsup` does the actual build and does not typecheck.

## Architecture

A zero-runtime-dependency library that pushes structured logs to Grafana Loki's
`/loki/api/v1/push` endpoint. Node.js server runtimes only — it uses `node:https`,
`node:http`, and `node:fs`, so it will not run on Edge Runtime.

Four layers, each usable standalone and all re-exported from `src/index.ts`:

- **`LokiTransport`** (`src/transport.ts`) — the only place that touches the network.
  Resolves `LOKI_PUSH_PATH` against the configured base URL at construction time,
  picks `http` vs `https` from the resolved protocol, and precomputes headers
  (including the Basic auth header) and TLS options. A `verify` string is read from
  disk with `readFileSync` **once, in the constructor** — CA rotation requires a new
  instance. `send()` resolves with a `TransportResult` for any HTTP response
  (`ok` is strictly `statusCode === 204`) and only rejects on socket-level errors.

- **`LokiEmitter`** (`src/emitter.ts`) — record → Loki payload. `buildPayload()`
  groups records into streams by their sanitized label set (the map key is the
  label object JSON-stringified with sorted keys), converts ms timestamps to the
  nanosecond *strings* Loki requires via `BigInt`, and renders the message as raw
  text or, with `asJson`, as `{message, ...extra}`.
  Note the `sending` re-entrancy guard: `emitBatch()` returns `null` and **silently
  drops the batch** if a send is already in flight. Preserve or deliberately revisit
  this — it is why the emitter never queues.

- **`BatchManager`** (`src/batch.ts`) — owns its own `LokiEmitter`. Flushes on
  capacity (in `add()`) and on a `setInterval` that is `unref()`'d so it never holds
  the process open. `flush()` swaps the buffer out synchronously before the async
  send, and swallows send failures to `console.error` — flushing is fire-and-forget.

- **`LokiLogger`** (`src/logger.ts`) — the public facade. It creates *either* a
  `BatchManager` (when `config.batch` is present) *or* a bare `LokiEmitter`, never
  both. This is why the log methods have the union return type
  `Promise<TransportResult | null> | void`: direct mode returns the transport
  promise, batch mode returns `void`. Callers that `await` a log call get different
  behavior depending on config — keep that in mind when changing the mode logic.

`src/labels.ts` sanitizes keys and values for Prometheus compatibility (strip
surrounding quotes → spaces/dots/dashes to `_` → drop remaining invalid chars).
A key that sanitizes to empty is dropped entirely. All tunable defaults live in
`src/constants.ts`.

## Conventions

- **No arrow functions.** Every callback in `src/` and `tests/` is a named function
  expression (`function handleResponse(res) {...}`), including `.catch()` and
  `setInterval` handlers. Match this; it is deliberate, not incidental.
- **Imports use `.js` extensions** on TypeScript sources (`from "./emitter.js"`) —
  required by the ESM output. `moduleResolution` is `bundler`.
- Explicit parameter and return type annotations on exported functions and methods.
- `extra` and label values are `Record<string, string>` throughout — the library
  does not stringify values for you.

## Testing

Vitest with `globals: true`, node environment, `tests/**/*.test.ts`.
Two styles are in use, and new tests should follow whichever fits:
- `tests/transport.test.ts` spins up a real `http.createServer()` on port 0 and
  asserts on the captured request body/headers.
- `tests/emitter.test.ts` and friends `vi.mock("../src/transport.js")` to avoid
  the network entirely.

## Packaging

Published as `byteforge-loki-logging-ts` and installed from GitHub, so the `prepare`
script runs `tsup` to build `dist/` at install time (`dist/` is gitignored). The
`exports` map serves ESM (`dist/index.js`) and CJS (`dist/index.cjs`) with separate
type declarations for each — adding a new public export means adding it to
`src/index.ts`, which is the sole tsup entry point.
