import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BatchManager } from "../src/batch.js";
import type { LogRecord } from "../src/types.js";

// Mock the emitter
const mockEmitBatch = vi.fn().mockResolvedValue({ ok: true, statusCode: 204, body: "" });

vi.mock("../src/emitter.js", function () {
  return {
    LokiEmitter: vi.fn().mockImplementation(function () {
      return { emitBatch: mockEmitBatch };
    }),
  };
});

function makeRecord(message: string = "test"): LogRecord {
  return {
    timestampMs: Date.now(),
    level: "info",
    message,
  };
}

describe("BatchManager", function () {
  let batch: BatchManager;

  beforeEach(function () {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(function () {
    if (batch) {
      batch.stop();
    }
    vi.useRealTimers();
  });

  it("should buffer records until capacity is reached", function () {
    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 3 },
    );

    batch.add(makeRecord("msg1"));
    batch.add(makeRecord("msg2"));
    expect(mockEmitBatch).not.toHaveBeenCalled();
    expect(batch.getBufferSize()).toBe(2);

    batch.add(makeRecord("msg3"));
    expect(mockEmitBatch).toHaveBeenCalledTimes(1);
    expect(mockEmitBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ message: "msg1" }),
        expect.objectContaining({ message: "msg2" }),
        expect.objectContaining({ message: "msg3" }),
      ]),
    );
    expect(batch.getBufferSize()).toBe(0);
  });

  it("should flush on interval when started", function () {
    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 100, flushIntervalMs: 1000 },
    );

    batch.start();
    batch.add(makeRecord("msg1"));

    expect(mockEmitBatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(mockEmitBatch).toHaveBeenCalledTimes(1);
  });

  it("should not flush on interval if buffer is empty", function () {
    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 100, flushIntervalMs: 1000 },
    );

    batch.start();
    vi.advanceTimersByTime(1000);
    expect(mockEmitBatch).not.toHaveBeenCalled();
  });

  it("should stop the interval timer", function () {
    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 100, flushIntervalMs: 1000 },
    );

    batch.start();
    batch.add(makeRecord());
    batch.stop();

    vi.advanceTimersByTime(2000);
    expect(mockEmitBatch).not.toHaveBeenCalled();
  });

  it("should flush remaining records on manual flush", function () {
    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 100 },
    );

    batch.add(makeRecord("msg1"));
    batch.add(makeRecord("msg2"));
    batch.flush();

    expect(mockEmitBatch).toHaveBeenCalledTimes(1);
    expect(batch.getBufferSize()).toBe(0);
  });

  it("should not start multiple timers", function () {
    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 100, flushIntervalMs: 1000 },
    );

    batch.start();
    batch.start(); // second call should be no-op
    batch.add(makeRecord());

    vi.advanceTimersByTime(1000);
    expect(mockEmitBatch).toHaveBeenCalledTimes(1);
  });
});
