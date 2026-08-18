import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import { LokiLogger } from "../src/logger.js";

/**
 * End-to-end delivery guarantees against a real HTTP server.
 *
 * Regression coverage for ticket f26568f7: batches were silently discarded
 * when a flush overlapped an in-flight push, so a merely *slow* Loki caused
 * record loss concentrated exactly during bursts.
 */

interface Stub {
  server: http.Server;
  url: string;
  received: string[];
  requestCount: number;
}

/**
 * @param responseDelayMs how long to wait before answering 204
 * @param hangRequests    how many leading requests to accept and never answer
 */
function startStub(responseDelayMs: number, hangRequests: number = 0): Promise<Stub> {
  return new Promise(function (resolve) {
    const stub: Partial<Stub> = { received: [], requestCount: 0 };

    const server = http.createServer(function handleRequest(
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) {
      const chunks: Buffer[] = [];
      req.on("data", function collect(chunk: Buffer) {
        chunks.push(chunk);
      });
      req.on("end", function respond() {
        stub.requestCount = (stub.requestCount ?? 0) + 1;
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

        if ((stub.requestCount ?? 0) <= hangRequests) {
          return; // accepted, never answered
        }

        // Counted at receipt, before the (possibly delayed) 204.
        for (const stream of payload.streams) {
          for (const value of stream.values) {
            stub.received?.push(JSON.parse(value[1]).message);
          }
        }
        setTimeout(function sendResponse() {
          res.writeHead(204);
          res.end();
        }, responseDelayMs);
      });
    });

    server.listen(0, function onListening() {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      stub.server = server;
      stub.url = `http://127.0.0.1:${port}`;
      resolve(stub as Stub);
    });
  });
}

function closeStub(stub: Stub): Promise<void> {
  return new Promise(function (resolve) {
    stub.server.close(function onClosed() {
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

describe("delivery guarantees", function () {
  let stub: Stub | null = null;

  afterEach(async function () {
    if (stub) {
      await closeStub(stub);
      stub = null;
    }
  });

  it("delivers every record when flushes overlap a slow in-flight push", async function () {
    stub = await startStub(150);

    const logger = new LokiLogger(
      {
        transport: { url: stub.url },
        emitter: { tags: { app: "repro" }, asJson: true },
        batch: { capacity: 2, flushIntervalMs: 50 },
      },
      "repro",
    );

    for (let i = 1; i <= 10; i++) {
      logger.info(`RECORD-${i}`);
    }

    await logger.close();

    const expected: string[] = [];
    for (let i = 1; i <= 10; i++) {
      expected.push(`RECORD-${i}`);
    }
    expect(stub.received.slice().sort()).toEqual(expected.slice().sort());
  });

  it("recovers from a hung push instead of going permanently silent", async function () {
    // Regression for ticket f26568f7 defect 2: with no request timeout a
    // socket that is accepted and never answered never settles, so the push
    // slot was held for the life of the process and every later record was
    // silently discarded.
    stub = await startStub(0, 1);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(function silence() {});

    const logger = new LokiLogger(
      {
        transport: { url: stub.url, timeoutMs: 250 },
        emitter: { tags: { app: "repro" }, asJson: true },
        batch: { capacity: 2, flushIntervalMs: 100, maxConcurrentPushes: 1 },
      },
      "repro",
    );

    logger.info("EARLY-1");
    logger.info("EARLY-2");

    await delay(600); // past the timeout

    logger.error("LATE-CRITICAL-1");
    logger.error("LATE-CRITICAL-2");

    await logger.close();

    // The point of the fix: logging keeps working after a hung push.
    expect(stub.received).toContain("LATE-CRITICAL-1");
    expect(stub.received).toContain("LATE-CRITICAL-2");

    // The hung batch itself is deliberately NOT retried — the server may have
    // already ingested it — but it is reported rather than lost silently.
    expect(stub.received).not.toContain("EARLY-1");
    const reported = errorSpy.mock.calls.some(function isTimeoutReport(call) {
      return String(call[0]).includes("timed out") && String(call[0]).includes("dropped 2 record(s)");
    });
    expect(reported).toBe(true);

    errorSpy.mockRestore();
  });
});
