export const LOKI_PUSH_PATH = "/loki/api/v1/push";
export const LOKI_SUCCESS_CODE = 204;
export const DEFAULT_LEVEL_TAG = "severity";
export const DEFAULT_LOGGER_TAG = "logger";
export const DEFAULT_BATCH_CAPACITY = 10;
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;
export const DEFAULT_MAX_CONCURRENT_PUSHES = 4;
export const DEFAULT_MAX_BUFFER_RECORDS = 10000;
export const DEFAULT_TIMEOUT_MS = 30000;

/** Statuses worth retrying; anything >= 500 is also retried. */
export const RETRYABLE_STATUS_CODES = [408, 429];

/** Regex for valid Prometheus label characters */
export const LABEL_VALID_CHARS = /[^a-zA-Z0-9_]/g;
