import { DEFAULT_LEVEL_TAG, DEFAULT_LOGGER_TAG } from "./constants.js";
import { sanitizeLabels } from "./labels.js";
import { LokiTransport } from "./transport.js";
import type {
  LokiEmitterConfig,
  LokiTransportConfig,
  LogRecord,
  LokiPushPayload,
  LokiStream,
  TransportResult,
} from "./types.js";

export class LokiEmitter {
  private readonly transport: LokiTransport;
  private readonly tags: Record<string, string>;
  private readonly asJson: boolean;
  private readonly propsToLabels: string[];
  private readonly levelTag: string;
  private readonly loggerTag: string;
  private readonly replaceTimestamp: boolean;
  private sending: boolean;

  constructor(
    transportConfig: LokiTransportConfig,
    emitterConfig: LokiEmitterConfig = {},
  ) {
    this.transport = new LokiTransport(transportConfig);
    this.tags = emitterConfig.tags ?? {};
    this.asJson = emitterConfig.asJson ?? false;
    this.propsToLabels = emitterConfig.propsToLabels ?? [];
    this.levelTag = emitterConfig.levelTag ?? DEFAULT_LEVEL_TAG;
    this.loggerTag = emitterConfig.loggerTag ?? DEFAULT_LOGGER_TAG;
    this.replaceTimestamp = emitterConfig.replaceTimestamp ?? true;
    this.sending = false;
  }

  async emit(record: LogRecord): Promise<TransportResult | null> {
    return this.emitBatch([record]);
  }

  async emitBatch(records: LogRecord[]): Promise<TransportResult | null> {
    if (this.sending || records.length === 0) {
      return null;
    }

    this.sending = true;
    try {
      const payload = this.buildPayload(records);
      const json = JSON.stringify(payload);
      return await this.transport.send(json);
    } finally {
      this.sending = false;
    }
  }

  buildPayload(records: LogRecord[]): LokiPushPayload {
    const streamMap = new Map<string, LokiStream>();

    for (const record of records) {
      const labels = this.buildLabels(record);
      const sanitized = sanitizeLabels(labels);
      const labelKey = JSON.stringify(sanitized, Object.keys(sanitized).sort());

      let stream = streamMap.get(labelKey);
      if (!stream) {
        stream = { stream: sanitized, values: [] };
        streamMap.set(labelKey, stream);
      }

      const timestampNs = this.toNanosecondString(
        this.replaceTimestamp ? Date.now() : record.timestampMs,
      );
      const message = this.asJson
        ? JSON.stringify({ message: record.message, ...record.extra })
        : record.message;

      stream.values.push([timestampNs, message]);
    }

    const streams: LokiStream[] = [];
    for (const stream of streamMap.values()) {
      streams.push(stream);
    }

    return { streams };
  }

  private buildLabels(record: LogRecord): Record<string, string> {
    const labels: Record<string, string> = { ...this.tags };

    labels[this.levelTag] = record.level;

    if (record.logger) {
      labels[this.loggerTag] = record.logger;
    }

    if (record.extra) {
      for (const prop of this.propsToLabels) {
        if (prop in record.extra) {
          labels[prop] = record.extra[prop];
        }
      }
    }

    return labels;
  }

  private toNanosecondString(timestampMs: number): string {
    return (BigInt(timestampMs) * BigInt(1_000_000)).toString();
  }
}
