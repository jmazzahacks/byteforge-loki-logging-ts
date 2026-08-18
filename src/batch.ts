import {
  DEFAULT_BATCH_CAPACITY,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_CONCURRENT_PUSHES,
  DEFAULT_MAX_BUFFER_RECORDS,
  RETRYABLE_STATUS_CODES,
} from "./constants.js";
import { LokiEmitter } from "./emitter.js";
import type {
  BatchConfig,
  LogRecord,
  LokiEmitterConfig,
  LokiTransportConfig,
  TransportResult,
} from "./types.js";

function isRetryable(statusCode: number): boolean {
  return RETRYABLE_STATUS_CODES.includes(statusCode) || statusCode >= 500;
}

export class BatchManager {
  private readonly emitter: LokiEmitter;
  private readonly capacity: number;
  private readonly flushIntervalMs: number;
  private readonly maxConcurrentPushes: number;
  private readonly maxBufferRecords: number;
  private buffer: LogRecord[];
  private timer: ReturnType<typeof setInterval> | null;
  private readonly pending: Set<Promise<void>>;
  private draining: boolean;
  private droppedSinceReport: number;
  private lastDropReportMs: number;

  constructor(
    transportConfig: LokiTransportConfig,
    emitterConfig: LokiEmitterConfig = {},
    batchConfig: BatchConfig = {},
  ) {
    this.emitter = new LokiEmitter(transportConfig, emitterConfig);
    this.capacity = batchConfig.capacity ?? DEFAULT_BATCH_CAPACITY;
    this.flushIntervalMs =
      batchConfig.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxConcurrentPushes =
      batchConfig.maxConcurrentPushes ?? DEFAULT_MAX_CONCURRENT_PUSHES;

    if (this.capacity < 1) {
      throw new Error("byteforge-loki: batch.capacity must be at least 1");
    }
    if (this.flushIntervalMs < 1) {
      throw new Error("byteforge-loki: batch.flushIntervalMs must be at least 1");
    }
    if (this.maxConcurrentPushes < 1) {
      // A ceiling of 0 would make flush() a permanent no-op and silently
      // grind every record away through the buffer limit.
      throw new Error(
        "byteforge-loki: batch.maxConcurrentPushes must be at least 1",
      );
    }

    // A cap below capacity would trim the buffer before it could ever reach
    // the capacity trigger, so records would only leave on the interval.
    const requestedMaxRecords =
      batchConfig.maxBufferRecords ?? DEFAULT_MAX_BUFFER_RECORDS;
    this.maxBufferRecords = Math.max(requestedMaxRecords, this.capacity);

    this.buffer = [];
    this.timer = null;
    this.pending = new Set();
    this.draining = false;
    this.droppedSinceReport = 0;
    this.lastDropReportMs = 0;
  }

  add(record: LogRecord): void {
    this.buffer.push(record);
    this.enforceBufferLimit();
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
    this.reportDrops(true);
  }

  /**
   * Send one batch of up to `capacity` records. Records are only detached
   * from the buffer when a push is actually going to carry them — at the
   * concurrency ceiling this is a no-op and they stay buffered.
   */
  flush(): void {
    if (this.buffer.length === 0 || this.pending.size >= this.maxConcurrentPushes) {
      return;
    }

    // Chunk at capacity: a backlog built up behind the ceiling must not be
    // posted as one oversized request that Loki would reject wholesale.
    const records = this.buffer.splice(0, this.capacity);
    const self = this;
    // A re-queued batch must NOT trigger the drain below, or a persistently
    // failing Loki would be retried as fast as the network allows. Letting
    // the interval timer pick it up is the pacing.
    let requeued = false;

    const push = this.emitter
      .emitBatch(records)
      .then(function onResult(result: TransportResult | null) {
        if (result && !result.ok) {
          // send() resolves for every HTTP status — only sockets reject —
          // so a non-2xx has to be handled here or it vanishes silently.
          requeued = self.handleFailure(records, result.statusCode, result.body);
        }
      })
      .catch(function onSocketError(err: unknown) {
        requeued = self.handleFailure(records, null, String(err));
      })
      .finally(function onSettled() {
        self.pending.delete(push);
        if (!requeued && self.buffer.length > 0 && !self.draining) {
          self.flush();
        }
      });

    this.pending.add(push);
  }

  /**
   * Flush everything and wait for it to land. Unlike `flush()` this settles
   * only once the buffer is empty and no push is outstanding, so a caller
   * can shut down without stranding the backlog. Failures are not retried
   * while draining — otherwise a dead Loki would never let shutdown finish.
   */
  async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.buffer.length > 0 || this.pending.size > 0) {
        this.flush();
        if (this.pending.size > 0) {
          await Promise.all(Array.from(this.pending));
        }
      }
    } finally {
      this.draining = false;
      this.reportDrops(true);
    }
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  getInFlightCount(): number {
    return this.pending.size;
  }

  /**
   * A failed push is put back at the front of the buffer for retryable
   * conditions, so the interval timer paces the retry. Anything the server
   * will keep rejecting (400 for a malformed stream, 401, 413) is dropped
   * rather than retried forever — but never silently.
   */
  private handleFailure(
    records: LogRecord[],
    statusCode: number | null,
    detail: string,
  ): boolean {
    // A null status means the socket itself failed, which is always worth
    // another attempt.
    const reason = statusCode === null ? "request failed" : `HTTP ${statusCode}`;
    const retryable = statusCode === null || isRetryable(statusCode);

    if (retryable && !this.draining) {
      this.buffer = records.concat(this.buffer);
      this.enforceBufferLimit();
      console.error(
        `byteforge-loki: push ${reason}, re-queued ${records.length} record(s)`,
        detail,
      );
      return true;
    }

    console.error(
      `byteforge-loki: push ${reason}, dropped ${records.length} record(s)`,
      detail,
    );
    return false;
  }

  /**
   * Bound the buffer so a sustained Loki outage cannot exhaust memory.
   * Drops the oldest records, because the newest are the ones a caller is
   * most likely to still need.
   */
  private enforceBufferLimit(): void {
    const overflow = this.buffer.length - this.maxBufferRecords;
    if (overflow <= 0) {
      return;
    }
    this.buffer.splice(0, overflow);
    this.droppedSinceReport += overflow;
    this.reportDrops(false);
  }

  /**
   * Report dropped records at most once per flush interval. Once the buffer
   * sits at its cap every single add() overflows by one, and a per-record
   * stderr write would block the host process harder than the loss it
   * reports.
   */
  private reportDrops(force: boolean): void {
    if (this.droppedSinceReport === 0) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastDropReportMs < this.flushIntervalMs) {
      return;
    }
    console.error(
      `byteforge-loki: buffer full at ${this.maxBufferRecords} records, dropped ${this.droppedSinceReport} oldest record(s)`,
    );
    this.droppedSinceReport = 0;
    this.lastDropReportMs = now;
  }
}
