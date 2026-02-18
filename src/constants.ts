export const LOKI_PUSH_PATH = "/loki/api/v1/push";
export const LOKI_SUCCESS_CODE = 204;
export const DEFAULT_LEVEL_TAG = "severity";
export const DEFAULT_LOGGER_TAG = "logger";
export const DEFAULT_BATCH_CAPACITY = 10;
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;

/** Regex for valid Prometheus label characters */
export const LABEL_VALID_CHARS = /[^a-zA-Z0-9_]/g;
