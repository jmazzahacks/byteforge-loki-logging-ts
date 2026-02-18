import { describe, it, expect, vi, beforeEach } from "vitest";
import { LokiEmitter } from "../src/emitter.js";
import type { LogRecord } from "../src/types.js";

// Mock the transport module so we don't make real HTTP requests
vi.mock("../src/transport.js", function () {
  return {
    LokiTransport: vi.fn().mockImplementation(function () {
      return {
        send: vi.fn().mockResolvedValue({ ok: true, statusCode: 204, body: "" }),
      };
    }),
  };
});

function makeRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestampMs: 1700000000000,
    level: "info",
    message: "test message",
    ...overrides,
  };
}

describe("LokiEmitter", function () {
  let emitter: LokiEmitter;

  beforeEach(function () {
    vi.clearAllMocks();
  });

  describe("buildPayload", function () {
    it("should build a payload with default labels", function () {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { replaceTimestamp: false },
      );
      const record = makeRecord();
      const payload = emitter.buildPayload([record]);

      expect(payload.streams).toHaveLength(1);
      expect(payload.streams[0].stream).toEqual({ severity: "info" });
      expect(payload.streams[0].values).toHaveLength(1);
      expect(payload.streams[0].values[0][0]).toBe("1700000000000000000");
      expect(payload.streams[0].values[0][1]).toBe("test message");
    });

    it("should include tags in labels", function () {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { tags: { app: "myapp", env: "prod" }, replaceTimestamp: false },
      );
      const record = makeRecord();
      const payload = emitter.buildPayload([record]);

      expect(payload.streams[0].stream).toEqual({
        app: "myapp",
        env: "prod",
        severity: "info",
      });
    });

    it("should include logger name when provided", function () {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { replaceTimestamp: false },
      );
      const record = makeRecord({ logger: "my.module" });
      const payload = emitter.buildPayload([record]);

      expect(payload.streams[0].stream["logger"]).toBe("my_module");
    });

    it("should promote props to labels", function () {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { propsToLabels: ["request_id"], replaceTimestamp: false },
      );
      const record = makeRecord({ extra: { request_id: "abc123" } });
      const payload = emitter.buildPayload([record]);

      expect(payload.streams[0].stream["request_id"]).toBe("abc123");
    });

    it("should format message as JSON when asJson is true", function () {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { asJson: true, replaceTimestamp: false },
      );
      const record = makeRecord({ extra: { key: "val" } });
      const payload = emitter.buildPayload([record]);

      const parsed = JSON.parse(payload.streams[0].values[0][1]);
      expect(parsed.message).toBe("test message");
      expect(parsed.key).toBe("val");
    });

    it("should group records with same labels into one stream", function () {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { replaceTimestamp: false },
      );
      const records = [
        makeRecord({ message: "msg1" }),
        makeRecord({ message: "msg2" }),
      ];
      const payload = emitter.buildPayload(records);

      expect(payload.streams).toHaveLength(1);
      expect(payload.streams[0].values).toHaveLength(2);
    });

    it("should split records with different labels into separate streams", function () {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { replaceTimestamp: false },
      );
      const records = [
        makeRecord({ level: "info", message: "msg1" }),
        makeRecord({ level: "error", message: "msg2" }),
      ];
      const payload = emitter.buildPayload(records);

      expect(payload.streams).toHaveLength(2);
    });

    it("should use custom level and logger tag names", function () {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { levelTag: "level", loggerTag: "source", replaceTimestamp: false },
      );
      const record = makeRecord({ logger: "myapp" });
      const payload = emitter.buildPayload([record]);

      expect(payload.streams[0].stream["level"]).toBe("info");
      expect(payload.streams[0].stream["source"]).toBe("myapp");
    });
  });

  describe("emit", function () {
    it("should return null for empty batch", async function () {
      emitter = new LokiEmitter({ url: "http://localhost:3100" });
      const result = await emitter.emitBatch([]);
      expect(result).toBeNull();
    });
  });
});
