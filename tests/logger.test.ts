import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LokiLogger } from "../src/logger.js";

// Mock the batch manager
const mockAdd = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockBatchFlush = vi.fn();
const mockDrain = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/batch.js", function () {
  return {
    BatchManager: vi.fn().mockImplementation(function () {
      return {
        add: mockAdd,
        start: mockStart,
        stop: mockStop,
        flush: mockBatchFlush,
        drain: mockDrain,
        close: mockClose,
      };
    }),
  };
});

// Mock the emitter
const mockEmit = vi.fn().mockResolvedValue({ ok: true, statusCode: 204, body: "" });

vi.mock("../src/emitter.js", function () {
  return {
    LokiEmitter: vi.fn().mockImplementation(function () {
      return { emit: mockEmit };
    }),
  };
});

describe("LokiLogger", function () {
  beforeEach(function () {
    vi.clearAllMocks();
  });

  describe("without batch config (direct mode)", function () {
    it("should send logs directly via emitter", async function () {
      const logger = new LokiLogger({
        transport: { url: "http://localhost:3100" },
      });

      await logger.info("hello world");

      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "info",
          message: "hello world",
        }),
      );
    });

    it("should pass extra fields to the record", async function () {
      const logger = new LokiLogger({
        transport: { url: "http://localhost:3100" },
      });

      await logger.error("failure", { request_id: "abc" });

      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          message: "failure",
          extra: { request_id: "abc" },
        }),
      );
    });

    it("should include logger name in records", async function () {
      const logger = new LokiLogger(
        { transport: { url: "http://localhost:3100" } },
        "my.app",
      );

      await logger.debug("trace msg");

      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          logger: "my.app",
          level: "debug",
        }),
      );
    });

    it("should support all log levels", async function () {
      const logger = new LokiLogger({
        transport: { url: "http://localhost:3100" },
      });

      await logger.debug("d");
      await logger.info("i");
      await logger.warning("w");
      await logger.error("e");
      await logger.critical("c");

      expect(mockEmit).toHaveBeenCalledTimes(5);
      const levels = mockEmit.mock.calls.map(
        function extractLevel(call: unknown[]) {
          return (call[0] as { level: string }).level;
        },
      );
      expect(levels).toEqual(["debug", "info", "warning", "error", "critical"]);
    });
  });

  describe("with batch config", function () {
    it("should buffer logs via batch manager", function () {
      const logger = new LokiLogger({
        transport: { url: "http://localhost:3100" },
        batch: { capacity: 10 },
      });

      logger.info("buffered msg");

      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(mockAdd).toHaveBeenCalledTimes(1);
      expect(mockAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "info",
          message: "buffered msg",
        }),
      );
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it("should flush batch on flush()", function () {
      const logger = new LokiLogger({
        transport: { url: "http://localhost:3100" },
        batch: { capacity: 10 },
      });

      logger.flush();
      expect(mockBatchFlush).toHaveBeenCalledTimes(1);
    });

    it("should close the batch manager on close()", async function () {
      const logger = new LokiLogger({
        transport: { url: "http://localhost:3100" },
        batch: { capacity: 10 },
      });

      await logger.close();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
