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
  },
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | *required* | Loki base URL |
| `auth` | `{ username, password }` | `undefined` | Basic authentication credentials |
| `headers` | `Record<string, string>` | `{}` | Additional HTTP headers |
| `verify` | `boolean \| string` | `true` | `true` = system CAs, `false` = skip TLS verification, `string` = path to PEM CA bundle |

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
| `replaceTimestamp` | `boolean` | `true` | Use current time instead of the record's timestamp |

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
| `capacity` | `number` | `10` | Flush when buffer reaches this many records |
| `flushIntervalMs` | `number` | `5000` | Flush on a timer interval (milliseconds) |

The batch timer uses `unref()` so it won't prevent Node.js from exiting.

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

### flush()

Force-send any buffered records immediately. Only relevant in batch mode.

```typescript
logger.flush();
```

### close()

Flush remaining records and stop the batch timer. Call this on shutdown.

```typescript
logger.close();
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
