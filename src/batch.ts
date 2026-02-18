import {
  DEFAULT_BATCH_CAPACITY,
  DEFAULT_FLUSH_INTERVAL_MS,
} from "./constants.js";
import { LokiEmitter } from "./emitter.js";
import type {
  BatchConfig,
  LogRecord,
  LokiEmitterConfig,
  LokiTransportConfig,
} from "./types.js";

export class BatchManager {
  private readonly emitter: LokiEmitter;
  private readonly capacity: number;
  private readonly flushIntervalMs: number;
  private buffer: LogRecord[];
  private timer: ReturnType<typeof setInterval> | null;

  constructor(
    transportConfig: LokiTransportConfig,
    emitterConfig: LokiEmitterConfig = {},
    batchConfig: BatchConfig = {},
  ) {
    this.emitter = new LokiEmitter(transportConfig, emitterConfig);
    this.capacity = batchConfig.capacity ?? DEFAULT_BATCH_CAPACITY;
    this.flushIntervalMs =
      batchConfig.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.buffer = [];
    this.timer = null;
  }

  add(record: LogRecord): void {
    this.buffer.push(record);
    if (this.buffer.length >= this.capacity) {
      this.flush();
    }
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    const self = this;
    this.timer = setInterval(function flushOnInterval() {
      self.flush();
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  flush(): void {
    if (this.buffer.length === 0) {
      return;
    }
    const records = this.buffer;
    this.buffer = [];
    this.emitter.emitBatch(records).catch(function handleFlushError(err: unknown) {
      console.error("byteforge-loki: flush error", err);
    });
  }

  getBufferSize(): number {
    return this.buffer.length;
  }
}
