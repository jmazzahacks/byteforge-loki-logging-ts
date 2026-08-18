import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BatchManager } from "../src/batch.js";
import type { LogRecord } from "../src/types.js";

// Mock the emitter
const mockEmitBatch = vi.fn();

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
    mockEmitBatch.mockResolvedValue({ ok: true, statusCode: 204, body: "" });
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

  it("keeps records buffered instead of dropping them when at the concurrency ceiling", function () {
    // Regression for ticket f26568f7 defect 1: a flush overlapping an
    // in-flight push used to detach the records and then discard them.
    mockEmitBatch.mockReturnValue(new Promise(function neverSettles() {}));

    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 2, maxConcurrentPushes: 1 },
    );

    batch.add(makeRecord("msg1"));
    batch.add(makeRecord("msg2"));
    expect(mockEmitBatch).toHaveBeenCalledTimes(1);
    expect(batch.getInFlightCount()).toBe(1);

    batch.add(makeRecord("msg3"));
    batch.add(makeRecord("msg4"));

    // Still one push out, and nothing was thrown away.
    expect(mockEmitBatch).toHaveBeenCalledTimes(1);
    expect(batch.getBufferSize()).toBe(2);
  });

  it("drains the backlog when an in-flight push settles", async function () {
    let releasePush: () => void = function noop() {};
    mockEmitBatch.mockReturnValueOnce(
      new Promise(function capture(resolve) {
        releasePush = function release() {
          resolve({ ok: true, statusCode: 204, body: "" });
        };
      }),
    );

    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 2, maxConcurrentPushes: 1 },
    );

    batch.add(makeRecord("msg1"));
    batch.add(makeRecord("msg2"));
    batch.add(makeRecord("msg3"));
    batch.add(makeRecord("msg4"));
    expect(batch.getBufferSize()).toBe(2);

    releasePush();
    await vi.waitFor(function backlogDrained() {
      expect(mockEmitBatch).toHaveBeenCalledTimes(2);
      expect(batch.getBufferSize()).toBe(0);
    });

    expect(mockEmitBatch).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ message: "msg3" }),
        expect.objectContaining({ message: "msg4" }),
      ]),
    );
  });

  it("bounds the buffer by dropping oldest records audibly", function () {
    mockEmitBatch.mockReturnValue(new Promise(function neverSettles() {}));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(function silence() {});

    // One push allowed, so the buffer genuinely backs up behind it.
    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 2, maxBufferRecords: 3, maxConcurrentPushes: 1 },
    );

    for (let i = 1; i <= 7; i++) {
      batch.add(makeRecord(`msg${i}`));
    }

    expect(batch.getBufferSize()).toBe(3);

    // Aggregated: one report, not one stderr write per dropped record.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("dropped 1 oldest record(s)");

    // The suppressed remainder is still reported when forced.
    batch.stop();
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[1][0]).toContain("dropped 1 oldest record(s)");

    errorSpy.mockRestore();
  });

  it("re-queues records when Loki answers with a retryable status", async function () {
    // Regression for ticket f26568f7 review finding 1: send() RESOLVES for
    // every HTTP status, so a 429 used to sail past .catch() and the batch
    // was discarded with nothing on stderr.
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(function silence() {});
    mockEmitBatch.mockResolvedValueOnce({
      ok: false,
      statusCode: 429,
      body: "rate limited",
    });

    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 2 },
    );

    batch.add(makeRecord("msg1"));
    batch.add(makeRecord("msg2"));

    await vi.waitFor(function requeued() {
      expect(batch.getBufferSize()).toBe(2);
    });
    expect(errorSpy.mock.calls[0][0]).toContain("re-queued 2 record(s)");

    errorSpy.mockRestore();
  });

  it("drops rather than retries a status the server will keep rejecting", async function () {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(function silence() {});
    mockEmitBatch.mockResolvedValueOnce({
      ok: false,
      statusCode: 400,
      body: "malformed stream",
    });

    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 2 },
    );

    batch.add(makeRecord("msg1"));
    batch.add(makeRecord("msg2"));

    await vi.waitFor(function reported() {
      expect(errorSpy).toHaveBeenCalled();
    });
    expect(errorSpy.mock.calls[0][0]).toContain("dropped 2 record(s)");
    expect(batch.getBufferSize()).toBe(0);

    errorSpy.mockRestore();
  });

  it("rejects a configuration that could never send", function () {
    expect(function zeroConcurrency() {
      return new BatchManager(
        { url: "http://localhost:3100" },
        {},
        { maxConcurrentPushes: 0 },
      );
    }).toThrow(/maxConcurrentPushes/);
  });

  it("never lets the buffer cap sit below capacity", function () {
    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 50, maxBufferRecords: 5 },
    );

    for (let i = 0; i < 50; i++) {
      batch.add(makeRecord(`msg${i}`));
    }
    // Clamped to capacity, so the capacity trigger still fires.
    expect(mockEmitBatch).toHaveBeenCalledTimes(1);
  });

  it("does not destroy the batch it just re-queued when the buffer is full", async function () {
    // Re-queueing at the front and then trimming from the front dropped the
    // retry itself, while stderr announced it had been re-queued.
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(function silence() {});
    mockEmitBatch.mockResolvedValueOnce({
      ok: false,
      statusCode: 500,
      body: "boom",
    });

    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 5, maxBufferRecords: 5, maxConcurrentPushes: 1 },
    );

    for (let i = 1; i <= 5; i++) {
      batch.add(makeRecord(`FIRST-${i}`));
    }
    for (let i = 1; i <= 5; i++) {
      batch.add(makeRecord(`SECOND-${i}`));
    }

    await vi.waitFor(function settled() {
      expect(errorSpy).toHaveBeenCalled();
    });

    // The buffer was already full, so the batch genuinely cannot be kept —
    // but it must be reported as dropped, not as re-queued.
    const messages = errorSpy.mock.calls.map(function first(call) {
      return String(call[0]);
    });
    const claimsRequeued = messages.some(function requeued(m) {
      return m.includes("re-queued");
    });
    const reportsDrop = messages.some(function dropped(m) {
      return m.includes("dropped 5 record(s)") && m.includes("buffer full");
    });
    expect(claimsRequeued).toBe(false);
    expect(reportsDrop).toBe(true);

    errorSpy.mockRestore();
  });

  it("drops records logged after close() instead of hanging the drain", async function () {
    vi.useRealTimers();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(function silence() {});

    batch = new BatchManager(
      { url: "http://localhost:3100" },
      {},
      { capacity: 2, flushIntervalMs: 50 },
    );

    batch.add(makeRecord("msg1"));
    batch.add(makeRecord("msg2"));

    // A service still logging while shutting down used to re-arm drain()
    // forever; close() must still resolve.
    const closing = batch.close();
    for (let i = 0; i < 100; i++) {
      batch.add(makeRecord(`LATE-${i}`));
    }
    await closing;

    expect(batch.getBufferSize()).toBe(0);
    const warned = errorSpy.mock.calls.some(function afterClose(call) {
      return String(call[0]).includes("after close()");
    });
    expect(warned).toBe(true);

    errorSpy.mockRestore();
  });
});
