import * as HttpClient from "effect/unstable/http/HttpClient";
import { Effect, Schema } from "effect";
import { AiError, Tool } from "effect/unstable/ai";
import { Toolkit } from "effect/unstable/ai";

const WebFetchParameters = Schema.Struct({
  url: Schema.String
});

export const WebFetchTool = Tool.make("webfetch", {
  description: "Fetch web content from a URL",
  parameters: WebFetchParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [HttpClient.HttpClient]
});

export type WebFetchTool = typeof WebFetchTool;

export const webfetchHandler = ({ url }: { url: string }, _context: Toolkit.HandlerContext<typeof WebFetchTool>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    const content = yield* response.text;
    return content;
  }).pipe(
    Effect.mapError((error) =>
      AiError.make({
        module: "WebFetchTool",
        method: "webfetchHandler",
        reason: new AiError.UnknownError({ description: String(error) })
      })
    )
  );
