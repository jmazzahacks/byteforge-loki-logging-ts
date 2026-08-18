import { LokiEmitter } from "./emitter.js";
import { BatchManager } from "./batch.js";
import type {
  LokiLoggerConfig,
  LogRecord,
  TransportResult,
} from "./types.js";

export class LokiLogger {
  private readonly emitter: LokiEmitter | null;
  private readonly batchManager: BatchManager | null;
  private readonly loggerName: string | undefined;

  constructor(config: LokiLoggerConfig, loggerName?: string) {
    this.loggerName = loggerName;

    if (config.batch) {
      this.emitter = null;
      this.batchManager = new BatchManager(
        config.transport,
        config.emitter,
        config.batch,
      );
      this.batchManager.start();
    } else {
      this.emitter = new LokiEmitter(config.transport, config.emitter);
      this.batchManager = null;
    }
  }

  debug(message: string, extra?: Record<string, string>): Promise<TransportResult | null> | void {
    return this.log("debug", message, extra);
  }

  info(message: string, extra?: Record<string, string>): Promise<TransportResult | null> | void {
    return this.log("info", message, extra);
  }

  warning(message: string, extra?: Record<string, string>): Promise<TransportResult | null> | void {
    return this.log("warning", message, extra);
  }

  error(message: string, extra?: Record<string, string>): Promise<TransportResult | null> | void {
    return this.log("error", message, extra);
  }

  critical(message: string, extra?: Record<string, string>): Promise<TransportResult | null> | void {
    return this.log("critical", message, extra);
  }

  flush(): void {
    if (this.batchManager) {
      this.batchManager.flush();
    }
  }

  /**
   * Stop the batch timer and wait for every buffered record to be sent.
   * Await this on shutdown — returning before the backlog lands is how a
   * `close(); process.exit(0)` sequence loses logs.
   */
  async close(): Promise<void> {
    if (this.batchManager) {
      this.batchManager.stop();
      await this.batchManager.drain();
    }
  }

  private log(
    level: string,
    message: string,
    extra?: Record<string, string>,
  ): Promise<TransportResult | null> | void {
    const record: LogRecord = {
      timestampMs: Date.now(),
      level,
      message,
      logger: this.loggerName,
      extra,
    };

    if (this.batchManager) {
      this.batchManager.add(record);
      return;
    }

    if (this.emitter) {
      return this.emitter.emit(record);
    }
  }
}
