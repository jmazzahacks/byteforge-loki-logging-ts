import { describe, it, expect, vi, beforeEach } from "vitest";
import { LokiEmitter } from "../src/emitter.js";
import { LokiTransport } from "../src/transport.js";
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
        { tags: { "app.name": "newsbash-web", env: "prod" }, replaceTimestamp: false },
      );
      const record = makeRecord();
      const payload = emitter.buildPayload([record]);

      expect(payload.streams[0].stream).toEqual({
        app_name: "newsbash-web",
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

      expect(payload.streams[0].stream["logger"]).toBe("my.module");
    });

    it("should promote props to labels", function () {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { propsToLabels: ["request.id"], replaceTimestamp: false },
      );
      const record = makeRecord({ extra: { "request.id": "abc-123.example" } });
      const payload = emitter.buildPayload([record]);

      expect(payload.streams[0].stream["request_id"]).toBe("abc-123.example");
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

    it("should keep formerly colliding values separate and group exact matches", function groupRawValues() {
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { propsToLabels: ["service"], replaceTimestamp: false },
      );
      const names = ["newsbash-web", "newsbash.web", "newsbash_web", "newsbash-web"];
      const records = names.map(function makeServiceRecord(service, index) {
        return makeRecord({ message: String(index), extra: { service } });
      });
      const payload = emitter.buildPayload(records);

      expect(payload.streams.map(function readService(stream) {
        return stream.stream.service;
      })).toEqual(["newsbash-web", "newsbash.web", "newsbash_web"]);
      expect(payload.streams.map(function readMessages(stream) {
        return stream.values.map(function readMessage(value) { return value[1]; });
      })).toEqual([["0", "3"], ["1"], ["2"]]);
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
    it("should JSON-escape label values without changing them", async function serializeRawValues() {
      const value = '"quoted"\\path\n日本語 🚀';
      emitter = new LokiEmitter(
        { url: "http://localhost:3100" },
        { tags: { application: value }, propsToLabels: ["detail"], replaceTimestamp: false },
      );
      await emitter.emit(makeRecord({ logger: value, extra: { detail: value } }));

      const transport = vi.mocked(LokiTransport).mock.results[0].value;
      expect(transport.send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(transport.send.mock.calls[0][0]);
      expect(payload.streams[0].stream).toEqual({
        application: value, severity: "info", logger: value, detail: value,
      });
    });

    it("should return null for empty batch", async function () {
      emitter = new LokiEmitter({ url: "http://localhost:3100" });
      const result = await emitter.emitBatch([]);
      expect(result).toBeNull();
    });
  });
});
