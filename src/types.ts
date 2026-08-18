export interface BasicAuth {
  username: string;
  password: string;
}

export interface LokiTransportConfig {
  url: string;
  auth?: BasicAuth;
  headers?: Record<string, string>;
  /** true = system CAs, false = skip verification, string = path to PEM CA bundle */
  verify?: boolean | string;
  /** Abort a push after this many ms of socket inactivity. 0 disables. */
  timeoutMs?: number;
}

export interface LokiEmitterConfig {
  tags?: Record<string, string>;
  asJson?: boolean;
  propsToLabels?: string[];
  levelTag?: string;
  loggerTag?: string;
  replaceTimestamp?: boolean;
}

export interface BatchConfig {
  capacity?: number;
  flushIntervalMs?: number;
  /** Max pushes in flight at once. Excess flushes stay buffered. */
  maxConcurrentPushes?: number;
  /** Hard cap on buffered records. Oldest are dropped (audibly) past this. */
  maxBufferRecords?: number;
}

export interface LokiLoggerConfig {
  transport: LokiTransportConfig;
  emitter?: LokiEmitterConfig;
  batch?: BatchConfig;
}

export interface LogRecord {
  /** Unix timestamp in milliseconds */
  timestampMs: number;
  level: string;
  message: string;
  logger?: string;
  extra?: Record<string, string>;
}

export interface TransportResult {
  ok: boolean;
  statusCode: number;
  body: string;
}

export interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

export interface LokiPushPayload {
  streams: LokiStream[];
}
