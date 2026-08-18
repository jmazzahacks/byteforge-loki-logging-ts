import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { LokiTransport, LokiTimeoutError } from "../src/transport.js";

describe("LokiTransport", function () {
  let server: http.Server;
  let port: number;
  let lastRequestBody: string;
  let lastRequestHeaders: http.IncomingHttpHeaders;
  let responseCode: number;
  let hangRequest: boolean;
  let stallAfterHeaders: boolean;
  let responseDelayMs: number;

  beforeEach(function () {
    responseCode = 204;
    hangRequest = false;
    stallAfterHeaders = false;
    responseDelayMs = 0;
    lastRequestBody = "";
    lastRequestHeaders = {};

    return new Promise<void>(function (resolve) {
      server = http.createServer(function handleRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
      ) {
        lastRequestHeaders = req.headers;
        const chunks: Buffer[] = [];

        req.on("data", function collectChunk(chunk: Buffer) {
          chunks.push(chunk);
        });

        req.on("end", function respond() {
          lastRequestBody = Buffer.concat(chunks).toString("utf-8");
          if (hangRequest) {
            return; // accepted, never answered
          }
          if (stallAfterHeaders) {
            // Headers and a partial body land, then the socket goes quiet —
            // so the timeout is guaranteed to fire mid-response.
            res.writeHead(204);
            res.write("");
            return;
          }
          setTimeout(function sendResponse() {
            res.writeHead(responseCode);
            res.end();
          }, responseDelayMs);
        });
      });

      server.listen(0, function onListening() {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(function () {
    return new Promise<void>(function (resolve) {
      server.close(function onClose() {
        resolve();
      });
    });
  });

  it("should send a POST request with JSON content type", async function () {
    const transport = new LokiTransport({
      url: `http://localhost:${port}`,
    });

    const payload = JSON.stringify({ streams: [] });
    const result = await transport.send(payload);

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(204);
    expect(lastRequestHeaders["content-type"]).toBe("application/json");
    expect(lastRequestBody).toBe(payload);
  });

  it("should include basic auth header when auth is provided", async function () {
    const transport = new LokiTransport({
      url: `http://localhost:${port}`,
      auth: { username: "user", password: "pass" },
    });

    await transport.send("{}");

    const expected = "Basic " + Buffer.from("user:pass").toString("base64");
    expect(lastRequestHeaders["authorization"]).toBe(expected);
  });

  it("should include custom headers", async function () {
    const transport = new LokiTransport({
      url: `http://localhost:${port}`,
      headers: { "X-Custom": "test-value" },
    });

    await transport.send("{}");

    expect(lastRequestHeaders["x-custom"]).toBe("test-value");
  });

  it("should report non-204 as not ok", async function () {
    responseCode = 400;
    const transport = new LokiTransport({
      url: `http://localhost:${port}`,
    });

    const result = await transport.send("{}");

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(400);
  });

  it("should post to /loki/api/v1/push path", async function () {
    let requestPath = "";
    server.removeAllListeners("request");
    server.on("request", function captureRequest(
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) {
      requestPath = req.url ?? "";
      res.writeHead(204);
      res.end();
    });

    const transport = new LokiTransport({
      url: `http://localhost:${port}`,
    });

    await transport.send("{}");

    expect(requestPath).toBe("/loki/api/v1/push");
  });

  it("rejects when the server accepts the request and never answers", async function () {
    // Regression for ticket f26568f7 defect 2: with no timeout this promise
    // never settled, holding a push slot for the life of the process.
    hangRequest = true;

    const transport = new LokiTransport({
      url: `http://localhost:${port}`,
      timeoutMs: 150,
    });

    await expect(transport.send(JSON.stringify({ streams: [] }))).rejects.toThrow(
      /timed out after 150ms/,
    );
  });

  it("does not time out a response that arrives within the budget", async function () {
    responseDelayMs = 100;

    const transport = new LokiTransport({
      url: `http://localhost:${port}`,
      timeoutMs: 1000,
    });

    const result = await transport.send(JSON.stringify({ streams: [] }));
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(204);
  });

  it("times out cleanly when the response stalls mid-body", async function () {
    // Destroying a timed-out request can surface an "error" event while the
    // response is already arriving. Headers-then-stall makes that path
    // deterministic rather than relying on a timing tie.
    stallAfterHeaders = true;

    const escaped: unknown[] = [];
    function captureEscape(err: unknown): void {
      escaped.push(err);
    }
    process.on("unhandledRejection", captureEscape);
    process.on("uncaughtException", captureEscape);

    const transport = new LokiTransport({
      url: `http://localhost:${port}`,
      timeoutMs: 60,
    });

    let outcome = "";
    await transport
      .send(JSON.stringify({ streams: [] }))
      .then(function onSuccess() {
        outcome = "resolved";
      })
      .catch(function onFailure(err: Error) {
        outcome = err.name;
      });

    await new Promise(function wait(resolve) {
      setTimeout(resolve, 250);
    });

    process.off("unhandledRejection", captureEscape);
    process.off("uncaughtException", captureEscape);

    expect(outcome).toBe("LokiTimeoutError");
    expect(escaped).toEqual([]);
  });

  it("rejects a timeoutMs that would silently disarm the timeout", function () {
    expect(function notANumber() {
      return new LokiTransport({
        url: `http://localhost:${port}`,
        timeoutMs: Number("not-a-number"),
      });
    }).toThrow(/timeoutMs/);

    expect(function negative() {
      return new LokiTransport({
        url: `http://localhost:${port}`,
        timeoutMs: -1,
      });
    }).toThrow(/timeoutMs/);
  });

  it("surfaces a timeout as a typed LokiTimeoutError", async function () {
    hangRequest = true;

    const transport = new LokiTransport({
      url: `http://localhost:${port}`,
      timeoutMs: 120,
    });

    await expect(
      transport.send(JSON.stringify({ streams: [] })),
    ).rejects.toBeInstanceOf(LokiTimeoutError);
  });
});
