import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import {
  LOKI_PUSH_PATH,
  LOKI_SUCCESS_CODE,
  DEFAULT_TIMEOUT_MS,
} from "./constants.js";
import type { LokiTransportConfig, TransportResult } from "./types.js";

/**
 * A push that exceeded `timeoutMs`. Distinct from other socket failures
 * because it is *ambiguous*: the request body was already sent, so Loki may
 * well have ingested the batch and only the acknowledgement was lost.
 */
export class LokiTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`loki push timed out after ${timeoutMs}ms`);
    this.name = "LokiTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class LokiTransport {
  private readonly url: URL;
  private readonly headers: Record<string, string>;
  private readonly requestModule: typeof https | typeof http;
  private readonly tlsOptions: https.RequestOptions;
  private readonly timeoutMs: number;

  constructor(config: LokiTransportConfig) {
    this.url = new URL(LOKI_PUSH_PATH, config.url);

    this.headers = {
      "Content-Type": "application/json",
      ...config.headers,
    };

    if (config.auth) {
      const credentials = Buffer.from(
        `${config.auth.username}:${config.auth.password}`,
      ).toString("base64");
      this.headers["Authorization"] = `Basic ${credentials}`;
    }

    this.requestModule =
      this.url.protocol === "https:" ? https : http;

    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // `??` only catches null/undefined, so NaN (a very easy accident via
    // Number(process.env.X)) would sail through and silently disarm the
    // timeout — restoring the exact hang this guards against.
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new Error(
        "byteforge-loki: transport.timeoutMs must be a non-negative finite number (0 disables)",
      );
    }

    this.tlsOptions = {};
    if (config.verify === false) {
      this.tlsOptions.rejectUnauthorized = false;
    } else if (typeof config.verify === "string") {
      this.tlsOptions.ca = fs.readFileSync(config.verify, "utf-8");
    }
  }

  send(payload: string): Promise<TransportResult> {
    return new Promise(function (
      this: LokiTransport,
      resolve: (result: TransportResult) => void,
      reject: (error: Error) => void,
    ) {
      // A timeout destroys the request while a response may already be
      // arriving, so both settlement paths can fire. That needs no guard —
      // promise settlement is idempotent, and the first path wins.
      const options: https.RequestOptions = {
        method: "POST",
        hostname: this.url.hostname,
        port: this.url.port || (this.url.protocol === "https:" ? 443 : 80),
        path: this.url.pathname,
        headers: {
          ...this.headers,
          "Content-Length": Buffer.byteLength(payload),
        },
        ...this.tlsOptions,
      };

      const req = this.requestModule.request(
        options,
        function handleResponse(res: http.IncomingMessage) {
          const chunks: Buffer[] = [];

          res.on("data", function collectChunk(chunk: Buffer) {
            chunks.push(chunk);
          });

          res.on("end", function buildResult() {
            const body = Buffer.concat(chunks).toString("utf-8");
            const statusCode = res.statusCode ?? 0;
            resolve({
              ok: statusCode === LOKI_SUCCESS_CODE,
              statusCode,
              body,
            });
          });
        },
      );

      req.on("error", function handleError(err: Error) {
        reject(err);
      });

      // Without this a socket that is accepted and never answered leaves the
      // promise pending forever, holding a push slot and stalling shutdown.
      // Node's default socket timeout is 0 (never), so nothing else rescues it.
      if (this.timeoutMs > 0) {
        const timeoutMs = this.timeoutMs;
        req.setTimeout(timeoutMs, function onTimeout() {
          req.destroy(new LokiTimeoutError(timeoutMs));
        });
      }

      req.write(payload);
      req.end();
    }.bind(this));
  }
}
