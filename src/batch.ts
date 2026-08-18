import {
  DEFAULT_BATCH_CAPACITY,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_CONCURRENT_PUSHES,
  DEFAULT_MAX_BUFFER_RECORDS,
  RETRYABLE_STATUS_CODES,
} from "./constants.js";
import { LokiEmitter } from "./emitter.js";
import { LokiTimeoutError } from "./transport.js";
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
  private closed: boolean;
  private reportedCloseRejection: boolean;
  private readonly stampOnAdd: boolean;
  private droppedSinceReport: number;
  private lastDropReportMs: number;

  constructor(
    transportConfig: LokiTransportConfig,
    emitterConfig: LokiEmitterConfig = {},
    batchConfig: BatchConfig = {},
  ) {
    // Stamp when the record is accepted, not when the payload is built, so a
    // retried batch keeps its original time. Restamping on retry pushed records
    // *later* than events that actually followed them, corrupting the timeline
    // in Loki.
    this.stampOnAdd = emitterConfig.replaceTimestamp ?? true;
    this.emitter = new LokiEmitter(transportConfig, {
      ...emitterConfig,
      replaceTimestamp: false,
    });
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
    this.closed = false;
    this.reportedCloseRejection = false;
    this.droppedSinceReport = 0;
    this.lastDropReportMs = 0;
  }

  add(record: LogRecord): void {
    if (this.closed) {
      // Buffering here would also make drain() unbounded, since every late
      // record re-arms its loop.
      if (!this.reportedCloseRejection) {
        console.error(
          "byteforge-loki: record(s) logged after close() are dropped (further reports suppressed)",
        );
        this.reportedCloseRejection = true;
      }
      return;
    }

    this.buffer.push(
      this.stampOnAdd ? { ...record, timestampMs: Date.now() } : record,
    );
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
    this.sendChunk(this.buffer.splice(0, this.capacity));
  }

  private sendChunk(records: LogRecord[]): void {
    if (records.length === 0) {
      return;
    }
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
          // A rejected push was NOT ingested, so retrying cannot duplicate.
          requeued = self.handleFailure(
            records,
            `HTTP ${result.statusCode}`,
            result.body,
            isRetryable(result.statusCode),
          );
        }
      })
      .catch(function onSocketError(err: unknown) {
        // A timeout is the one ambiguous failure: the body was already sent,
        // so Loki may have ingested the batch and only the ack was lost.
        // Retrying would duplicate — and since replaceTimestamp restamps each
        // copy, Loki cannot dedupe them. Prefer losing the batch loudly over
        // amplifying a slow Loki into a duplicate storm.
        const timedOut = err instanceof LokiTimeoutError;
        requeued = self.handleFailure(
          records,
          timedOut ? "timed out" : "request failed",
          String(err),
          !timedOut,
        );
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
   * Deliver the records buffered at the moment of the call and wait for them
   * to land. Records added *during* the drain are NOT included and stay
   * buffered — bounding the work is what stops a service that logs while
   * shutting down from keeping this from ever resolving.
   *
   * For shutdown use `close()`, which stops accepting records first so
   * nothing is left behind. Failures are not retried while draining, since a
   * dead Loki would otherwise never let shutdown finish.
   */
  async drain(): Promise<void> {
    this.draining = true;
    try {
      // Bounded by what is buffered on entry. Without this, anything still
      // logging during shutdown re-arms the loop and close() never returns —
      // the process then dies by SIGKILL, losing the very buffer drain()
      // exists to deliver.
      let remaining = this.buffer.length;
      while (remaining > 0 || this.pending.size > 0) {
        if (remaining > 0 && this.pending.size < this.maxConcurrentPushes) {
          const take = Math.min(this.capacity, remaining);
          remaining -= take;
          this.sendChunk(this.buffer.splice(0, take));
          continue;
        }
        await Promise.all(Array.from(this.pending));
      }
    } finally {
      this.draining = false;
      this.reportDrops(true);
    }
  }

  /** Stop accepting records, stop the timer, and deliver what is buffered. */
  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    await this.drain();
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  getInFlightCount(): number {
    return this.pending.size;
  }

  /**
   * A failed push is put back at the front of the buffer when the failure is
   * retryable, so the interval timer paces the retry. Anything the server
   * will keep rejecting (400 for a malformed stream, 401, 413) — and anything
   * that may have already landed (a timeout) — is dropped rather than retried,
   * but never silently.
   */
  private handleFailure(
    records: LogRecord[],
    reason: string,
    detail: string,
    retryable: boolean,
  ): boolean {
    if (retryable && !this.draining) {
      // Make room explicitly rather than re-queueing and then letting
      // enforceBufferLimit() trim from the front — the front is exactly the
      // batch just put back, so the retry would be destroyed microseconds
      // after stderr announced it had been re-queued.
      const room = this.maxBufferRecords - this.buffer.length;
      if (room <= 0) {
        console.error(
          `byteforge-loki: push ${reason}, dropped ${records.length} record(s) — buffer full at ${this.maxBufferRecords}`,
          detail,
        );
        return false;
      }

      // If only part of the batch fits, keep its newest records.
      const kept = records.slice(Math.max(0, records.length - room));
      this.buffer = kept.concat(this.buffer);

      const dropped = records.length - kept.length;
      const suffix =
        dropped > 0
          ? `, dropped ${dropped} — buffer full at ${this.maxBufferRecords}`
          : "";
      console.error(
        `byteforge-loki: push ${reason}, re-queued ${kept.length} record(s)${suffix}`,
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
