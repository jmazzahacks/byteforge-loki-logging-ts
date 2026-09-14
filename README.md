# byteforge-loki-logging-ts

TypeScript library for pushing structured logs to [Grafana Loki](https://grafana.com/oss/loki/). Zero runtime dependencies -- uses only Node.js built-in modules (`node:https`, `node:http`, `node:fs`).

Designed for **Node.js server runtimes** (Next.js API routes, standalone Node servers, etc.). Not compatible with Edge Runtime, which lacks `node:https` and `node:fs`.

## Features

- Push structured logs to Loki's HTTP API (`/loki/api/v1/push`)
- Self-signed SSL certificate support via PEM CA bundles
- Basic authentication
- Prometheus-compatible label sanitization
- Batching with capacity-based and time-interval flushing
- JSON or plaintext log messages
- Promote log record fields to Loki labels
- Custom headers for proxy/gateway scenarios
- CJS and ESM builds with full type declarations

## Installation

```bash
npm install byteforge-loki-logging-ts
```

Requires Node.js >= 18.

## Quick Start

```typescript
import { LokiLogger } from "byteforge-loki-logging-ts";

const logger = new LokiLogger({
  transport: {
    url: "https://loki.example.com",
  },
  emitter: {
    tags: { app: "my-app", env: "production" },
  },
});

await logger.info("Server started", { port: "3000" });
await logger.error("Request failed", { path: "/api/users", status: "500" });
```

## Configuration

`LokiLogger` accepts a config object with three sections: `transport`, `emitter`, and `batch`.

### Transport

Controls the HTTP connection to Loki.

```typescript
const logger = new LokiLogger({
  transport: {
    url: "https://loki.example.com",
    auth: { username: "user", password: "pass" },
    headers: { "X-Scope-OrgID": "tenant-1" },
    verify: "/path/to/ca.pem",
    timeoutMs: 30000,
  },
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | *required* | Loki base URL |
| `auth` | `{ username, password }` | `undefined` | Basic authentication credentials |
| `headers` | `Record<string, string>` | `{}` | Additional HTTP headers |
| `verify` | `boolean \| string` | `true` | `true` = system CAs, `false` = skip TLS verification, `string` = path to PEM CA bundle |
| `timeoutMs` | `number` | `30000` | Abort a push after this many ms of socket inactivity. `0` disables the timeout |

### Emitter

Controls how log records are formatted and labeled.

```typescript
const logger = new LokiLogger({
  transport: { url: "https://loki.example.com" },
  emitter: {
    tags: { app: "my-app", env: "staging" },
    asJson: true,
    propsToLabels: ["request_id"],
    levelTag: "severity",
    loggerTag: "logger",
    replaceTimestamp: true,
  },
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `tags` | `Record<string, string>` | `{}` | Default labels applied to every log entry |
| `asJson` | `boolean` | `false` | Format log message as JSON (includes `extra` fields) |
| `propsToLabels` | `string[]` | `[]` | Keys from `extra` to promote to Loki labels |
| `levelTag` | `string` | `"severity"` | Label name for the log level |
| `loggerTag` | `string` | `"logger"` | Label name for the logger name |
| `replaceTimestamp` | `boolean` | `true` | Use current time instead of the record's timestamp. In batch mode the stamp is taken when the record is accepted, so a retried batch keeps its original time rather than jumping ahead of events that followed it |

### Batch

When provided, logs are buffered and sent in batches instead of individually. Omit this section for direct (unbatched) mode.

```typescript
const logger = new LokiLogger({
  transport: { url: "https://loki.example.com" },
  batch: {
    capacity: 20,
    flushIntervalMs: 3000,
  },
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `capacity` | `number` | `10` | Flush when buffer reaches this many records; also the max records per push |
| `flushIntervalMs` | `number` | `5000` | Flush on a timer interval (milliseconds) |
| `maxConcurrentPushes` | `number` | `4` | Max pushes in flight at once. Beyond this, records stay buffered rather than being sent concurrently |
| `maxBufferRecords` | `number` | `10000` | Hard cap on buffered records. Clamped up to `capacity` if set lower |

The batch timer uses `unref()` so it won't prevent Node.js from exiting.

### Request timeouts

Node's default socket timeout is `0` (never), so a Loki that accepts a
connection and never answers would otherwise leave the push pending forever —
holding a concurrency slot and stalling `close()`. Pushes therefore abort after
`transport.timeoutMs` and reject with a `LokiTimeoutError`.

Note this is a socket **inactivity** timer, not a total request deadline: it
resets on every byte, so a response that trickles will not trip it.

In batch mode a timed-out batch is **retried once**. The request body was
already sent, so Loki may have ingested the records and only the
acknowledgement was lost. The retry is safe anyway: records are timestamped
when they are accepted, so the retry is byte-identical, and Loki discards an
entry whose stream, timestamp and line all match one it already holds, so a
one-off timeout costs at most a rare duplicate line rather than the batch.

A record that times out a second time is dropped and reported. Retrying
indefinitely would turn a Loki that ingests but acknowledges slower than
`timeoutMs` into an endless resend loop, starving newer records — so a
persistently slow Loki is better fixed by raising `timeoutMs`.

### Delivery behavior

Records are only removed from the buffer when a push is actually going to carry
them, so a flush that arrives while an earlier push is still in flight does not
lose anything.

- **Retryable failures** — connection errors, HTTP 408, 429, and any 5xx — put
  the batch back at the front of the buffer. The retry waits for the next flush
  interval rather than firing immediately, so a struggling Loki isn't hammered.
- **Timeouts** are retried the same way, but only once per record (see above).
- **Permanent failures** (400, 401, 413 — anything the server will keep
  rejecting) drop the batch instead of retrying forever.
- **During `close()`** nothing is retried, so a dead Loki cannot keep shutdown
  from finishing; failed batches are dropped.
- **Buffer overflow** drops the oldest records, since the newest are the ones
  you are most likely to still need. A retried batch that no longer fits is
  reported as dropped, not as re-queued.

Every failed push and buffer overflow is reported on `stderr` with a count and
the running total dropped so far, followed by Loki's response body when it sent
one. Overflow reports are aggregated to at most one line per flush interval, so
a sustained outage does not turn into a stderr storm. Records logged after
`close()` are reported only once, with no count. To alert on loss, poll
`logger.getDroppedCount()` rather than reading stderr — it counts every path.

## API

### Log Methods

All log methods accept a message and an optional `extra` record of string key-value pairs.

```typescript
logger.debug("Detailed trace info");
logger.info("User logged in", { user_id: "42" });
logger.warning("Disk usage high", { percent: "89" });
logger.error("Request failed", { status: "500" });
logger.critical("Database unreachable");
```

In **direct mode** (no `batch` config), these return `Promise<TransportResult | null>`.
In **batch mode**, these return `void` -- records are buffered.

Direct mode issues one HTTP request per call with no concurrency limit, so
`await` each call (or use batch mode) if you emit in bursts. The
`maxConcurrentPushes` ceiling applies to batch mode only.

### flush()

Force-send any buffered records immediately. Only relevant in batch mode.

```typescript
logger.flush();
```

### close()

Stop the batch timer and wait for the buffered records to be sent. Returns a
promise — **await it on shutdown**, or a `close()` immediately followed by
`process.exit()` will drop the backlog.

```typescript
await logger.close();
```

`close()` drains the records buffered at the moment it is called. Anything
logged *after* it is dropped, and reported once on `stderr`. That is deliberate:
a service still logging while it shuts down would otherwise keep re-arming the
drain and `close()` would never resolve — leaving the process to be SIGKILLed,
which loses the entire buffer rather than saving it.

### getDroppedCount()

Total records discarded over the logger's lifetime, across every drop path:
permanent failures, a second timeout, failures during `close()`, buffer
overflow, and records logged after `close()`. Poll it to alert on log loss. Always `0` in direct
mode, where each failure surfaces on the promise the log call returns.

```typescript
if (logger.getDroppedCount() > 0) {
  metrics.gauge("loki_records_dropped", logger.getDroppedCount());
}
```

## Named Loggers

Pass a logger name as the second constructor argument. It appears as a label on every log entry.

```typescript
const logger = new LokiLogger(config, "api.users");
// All logs will include {logger: "api_users"} label
```

## Self-Signed Certificates

Point `verify` to your CA bundle PEM file. The certificate is read once at construction time.

```typescript
const logger = new LokiLogger({
  transport: {
    url: "https://loki.internal:3100",
    verify: "/etc/ssl/certs/my-ca.pem",
  },
});
```

To skip TLS verification entirely (not recommended for production):

```typescript
const logger = new LokiLogger({
  transport: {
    url: "https://loki.internal:3100",
    verify: false,
  },
});
```

## Label Sanitization

Labels are automatically sanitized for Prometheus/Loki compatibility:

- Surrounding quotes are stripped
- Spaces, dots, and dashes become underscores
- All other non-alphanumeric/underscore characters are removed

```typescript
import { sanitizeLabel } from "byteforge-loki-logging-ts";

sanitizeLabel('"my app.log-level"'); // "my_app_log_level"
```

## Advanced Usage

### Using Lower-Level Components

The library exports individual components for advanced scenarios.

```typescript
import {
  LokiTransport,
  LokiEmitter,
  BatchManager,
  sanitizeLabels,
} from "byteforge-loki-logging-ts";
```

### Next.js API Route Example

```typescript
// app/api/example/route.ts
import { LokiLogger } from "byteforge-loki-logging-ts";
import { NextResponse } from "next/server";

const logger = new LokiLogger({
  transport: {
    url: process.env.LOKI_URL!,
    auth: {
      username: process.env.LOKI_USER!,
      password: process.env.LOKI_PASS!,
    },
    verify: process.env.LOKI_CA_PATH || true,
  },
  emitter: {
    tags: { app: "my-nextjs-app" },
    asJson: true,
  },
  batch: { capacity: 20, flushIntervalMs: 3000 },
});

export async function GET() {
  logger.info("GET /api/example", { method: "GET" });
  return NextResponse.json({ ok: true });
}
```

## Development

```bash
npm install
npm test            # Run tests
npm run test:watch  # Run tests in watch mode
npm run build       # Build CJS + ESM + type declarations
```

## License

MIT
