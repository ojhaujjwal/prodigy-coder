import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { BunServices } from "@effect/platform-bun";

const LOG_DIR = "logs";
const LOG_FILE = `${LOG_DIR}/http-debug.log`;

const ensureLogDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(LOG_DIR);
  if (!exists) {
    yield* fs.makeDirectory(LOG_DIR, { recursive: true });
  }
}).pipe(Effect.orDie);

const appendToLog = (message: string) =>
  Effect.gen(function* () {
    yield* ensureLogDir;
    const fs = yield* FileSystem.FileSystem;
    const timestamp = new Date().toISOString();
    const logEntry = `\n[${timestamp}] ${message}\n`;
    yield* fs.writeFileString(LOG_FILE, logEntry, { flag: "a" });
  }).pipe(Effect.provide(BunServices.layer), Effect.orDie);

const formatRequest = (request: HttpClientRequest.HttpClientRequest): string => {
  const method = request.method;
  const urlStr = request.url;
  const headers = { ...request.headers };
  let body: string;
  if (request.body._tag === "Uint8Array") {
    body = new TextDecoder().decode(request.body.body);
  } else if (request.body._tag === "Raw") {
    body = typeof request.body.body === "string" ? request.body.body : JSON.stringify(request.body.body);
  } else {
    body = `[${request.body._tag}]`;
  }

  const truncatedBody = body.length > 2000 ? body.slice(0, 2000) + "...(truncated)" : body;

  return `>>> REQUEST ${method} ${urlStr}\nHeaders: ${JSON.stringify(headers, null, 2)}\nBody: ${truncatedBody}`;
};

const formatResponse = (response: HttpClientResponse.HttpClientResponse): string => {
  const status = response.status;
  const headers = { ...response.headers };
  const contentType = headers["content-type"] || "";
  const isStreaming = contentType.includes("text/event-stream") || contentType.includes("stream");

  if (isStreaming) {
    return `<<< RESPONSE ${status} [STREAMING]\nHeaders: ${JSON.stringify(headers, null, 2)}\nBody: [streaming response - body not logged to avoid consuming stream]`;
  }

  return `<<< RESPONSE ${status}\nHeaders: ${JSON.stringify(headers, null, 2)}\nBody: [non-streaming response - body not logged]`;
};

export const withHttpDebug = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  client.pipe(
    HttpClient.transform((responseEffect, request) =>
      Effect.tap(responseEffect, (response) => {
        const reqFormatted = formatRequest(request);
        const resFormatted = formatResponse(response);
        return appendToLog(`${reqFormatted}\n\n${resFormatted}`);
      })
    )
  );

export const makeHttpDebugLayer = (): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const enabled = yield* Config.boolean("PRODIGY_HTTP_DEBUG").pipe(Config.withDefault(false));
      return enabled ? withHttpDebug(client) : client;
    }).pipe(Effect.orDie)
  );
