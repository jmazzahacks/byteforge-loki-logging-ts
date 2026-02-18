import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import { LOKI_PUSH_PATH, LOKI_SUCCESS_CODE } from "./constants.js";
import type { LokiTransportConfig, TransportResult } from "./types.js";

export class LokiTransport {
  private readonly url: URL;
  private readonly headers: Record<string, string>;
  private readonly requestModule: typeof https | typeof http;
  private readonly tlsOptions: https.RequestOptions;

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

      req.write(payload);
      req.end();
    }.bind(this));
  }
}
