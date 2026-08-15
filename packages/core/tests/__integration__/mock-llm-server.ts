import { Context, Effect, Layer, Redacted, Scope, Stream } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as HttpClient from "effect/unstable/http/HttpClient";

/**
 * A test-local provider layer: point `@effect/ai-openai`'s language model at
 * the wire-level mock server, the way a composition root would point it at a
 * real API. Provider selection is an adapter concern (the CLI owns the
 * production one), so this lives with the tests, not in core's public API.
 */
export const openaiCompatProviderLayer = (
  baseUrl: string
): Layer.Layer<LanguageModel.LanguageModel, never, HttpClient.HttpClient> => {
  const clientLayer = OpenAiClient.layer({ apiKey: Redacted.make("test"), apiUrl: baseUrl });
  const languageModelLayer = OpenAiLanguageModel.layer({ model: "test-model" });
  return languageModelLayer.pipe(Layer.provide(clientLayer));
};

/**
 * A wire-level OpenAI-compatible chat-completions mock server, the core
 * analogue of the CLI's `createMockOpenAIServer`. It records every request
 * body so tests can assert the provider-visible prompt transcript, and serves
 * scripted SSE responses per turn.
 *
 * The server is a real `HttpRouter`/`BunHttpServer` over `localhost`, so the
 * run's provider layer talks to it over actual HTTP — the only boundary that
 * is mocked is the LLM provider itself.
 */

/** A single streamed response part, mirroring the CLI's `MockPart`. */
export type MockLLMPart =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly params: unknown }
  | {
      readonly type: "finish";
      readonly reason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "pause" | "other" | "unknown";
    };

/** A full scripted turn: the parts streamed in one chat completion. */
export type MockLLMTurn = ReadonlyArray<MockLLMPart>;

const buildResponseObject = (responseId: string, status: "in_progress" | "completed") => ({
  metadata: null,
  temperature: null,
  top_p: null,
  model: "test-model",
  tools: [],
  tool_choice: "auto",
  id: responseId,
  object: "response",
  status,
  created_at: Math.floor(Date.now() / 1000),
  error: null,
  incomplete_details: null,
  output: [],
  instructions: null,
  parallel_tool_calls: false
});

const usageObject = {
  input_tokens: 1,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 1,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 2
};

/**
 * Build SSE chunks in the OpenAI Responses API format (`/v1/responses`),
 * which `@effect/ai-openai`'s `OpenAiLanguageModel` uses via
 * `createResponseStream`. Mirrors the CLI's `buildResponsesSSEChunks`.
 */
const buildResponsesSSEChunks = (parts: ReadonlyArray<MockLLMPart>): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  const responseId = `resp_mock_${Date.now()}`;
  let seq = 0;

  const createdEvent = `event: response.created\ndata: ${JSON.stringify({
    type: "response.created",
    sequence_number: seq++,
    response: buildResponseObject(responseId, "in_progress")
  })}\n\n`;
  chunks.push(encoder.encode(createdEvent));

  let outputIndex = 0;

  for (const part of parts) {
    if (part.type === "text-delta") {
      const itemId = `item_text_${outputIndex}`;
      chunks.push(
        encoder.encode(
          `event: response.output_item.added\ndata: ${JSON.stringify({
            type: "response.output_item.added",
            output_index: outputIndex,
            sequence_number: seq++,
            item: {
              id: itemId,
              type: "message",
              role: "assistant",
              content: [],
              status: "in_progress"
            }
          })}\n\n`
        )
      );
      chunks.push(
        encoder.encode(
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            delta: part.delta,
            sequence_number: seq++,
            logprobs: []
          })}\n\n`
        )
      );
      chunks.push(
        encoder.encode(
          `event: response.output_text.done\ndata: ${JSON.stringify({
            type: "response.output_text.done",
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            text: part.delta,
            sequence_number: seq++,
            logprobs: []
          })}\n\n`
        )
      );
      chunks.push(
        encoder.encode(
          `event: response.output_item.done\ndata: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: outputIndex,
            sequence_number: seq++,
            item: {
              id: itemId,
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: part.delta, annotations: [], logprobs: [] }],
              status: "completed"
            }
          })}\n\n`
        )
      );
      outputIndex++;
    } else if (part.type === "tool-call") {
      const itemId = part.id;
      chunks.push(
        encoder.encode(
          `event: response.output_item.added\ndata: ${JSON.stringify({
            type: "response.output_item.added",
            output_index: outputIndex,
            sequence_number: seq++,
            item: {
              id: itemId,
              type: "function_call",
              call_id: itemId,
              name: part.name,
              arguments: ""
            }
          })}\n\n`
        )
      );
      chunks.push(
        encoder.encode(
          `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
            type: "response.function_call_arguments.done",
            item_id: itemId,
            output_index: outputIndex,
            sequence_number: seq++,
            name: part.name,
            arguments: JSON.stringify(part.params)
          })}\n\n`
        )
      );
      chunks.push(
        encoder.encode(
          `event: response.output_item.done\ndata: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: outputIndex,
            sequence_number: seq++,
            item: {
              id: itemId,
              type: "function_call",
              call_id: itemId,
              name: part.name,
              arguments: JSON.stringify(part.params)
            }
          })}\n\n`
        )
      );
      outputIndex++;
    }
  }

  const completedEvent = `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    sequence_number: seq++,
    response: {
      ...buildResponseObject(responseId, "completed"),
      usage: usageObject
    }
  })}\n\n`;
  chunks.push(encoder.encode(completedEvent));

  return chunks;
};

const buildSSEChunks = (parts: ReadonlyArray<MockLLMPart>): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const part of parts) {
    if (part.type === "text-delta") {
      chunks.push(
        encoder.encode(
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: Date.now(),
            model: "test-model",
            choices: [{ index: 0, delta: { content: part.delta }, finish_reason: null }]
          })}\n\n`
        )
      );
    } else if (part.type === "tool-call") {
      chunks.push(
        encoder.encode(
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: Date.now(),
            model: "test-model",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: part.id,
                      type: "function",
                      function: { name: part.name, arguments: JSON.stringify(part.params) }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
      );
    }
  }

  const finishChunk = `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  })}\n\n`;
  chunks.push(encoder.encode(finishChunk));
  chunks.push(encoder.encode("data: [DONE]\n\n"));

  return chunks;
};

export type MockLLMServer = {
  readonly url: string;
  readonly calls: ReadonlyArray<unknown>;
};

/**
 * Create the wire-level mock OpenAI server. Returns the base URL (point the
 * provider at `url/v1`) and a `calls` array recording every request body.
 */
export const createMockLLMServer = (
  turns: ReadonlyArray<MockLLMTurn>
): Effect.Effect<MockLLMServer, never, Scope.Scope> => {
  const calls: unknown[] = [];
  let turnIndex = 0;

  const routeEffect = (buildChunks: (parts: ReadonlyArray<MockLLMPart>) => Uint8Array[]) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json;
      calls.push(body);

      const currentTurns = turns[turnIndex] ?? [];
      turnIndex += 1;

      const chunks = buildChunks(currentTurns);
      const stream = Stream.fromIterable(chunks);
      return HttpServerResponse.stream(stream, { contentType: "text/event-stream" });
    });

  const chatCompletionsLayer = HttpRouter.add("POST", "/v1/chat/completions", routeEffect(buildSSEChunks));
  // `@effect/ai-openai`'s language model streams via the Responses API
  // (`createResponseStream`), so serve that endpoint with the matching SSE
  // format, mirroring the CLI's dual-endpoint mock.
  const responsesLayer = HttpRouter.add("POST", "/v1/responses", routeEffect(buildResponsesSSEChunks));
  const appLayer = Layer.merge(chatCompletionsLayer, responsesLayer);
  const serverLayer = HttpRouter.serve(appLayer, { disableListenLog: true }).pipe(
    Layer.provideMerge(BunHttpServer.layer({ port: 0 }))
  );

  return Effect.flatMap(Layer.build(serverLayer), (context) =>
    Effect.sync(() => {
      const server = Context.get(context, HttpServer.HttpServer);
      const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
      return { url: `http://localhost:${port}/v1`, calls };
    })
  );
};
