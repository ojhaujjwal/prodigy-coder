import { Context, Effect, Layer, Schema, Scope, Stream } from "effect";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Response from "effect/unstable/ai/Response";
import * as AiError from "effect/unstable/ai/AiError";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import type { ConfigData } from "../config.ts";
import type { JsonValue } from "@prodigy/core";
import { SessionSchema, type Session, type Message } from "../session.ts";
import { AgenticToolkit, withApproval, EmptySkillsRepoLayer } from "../tools/index.ts";
import { ApprovalGate } from "../approval-gate.ts";

export type MockPart =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; id: string; name: string; params: JsonValue }
  | {
      type: "finish";
      reason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "pause" | "other" | "unknown";
    };

export type TurnResponse = MockPart[];

const mockPartToEncoded = (part: MockPart): Response.StreamPartEncoded => {
  switch (part.type) {
    case "text-delta":
      return {
        type: "text-delta",
        id: "mock-id",
        delta: part.delta
      };
    case "tool-call":
      return {
        type: "tool-call",
        id: part.id,
        name: part.name,
        params: part.params
      };
    case "finish":
      return {
        type: "finish",
        reason: part.reason,
        usage: {
          inputTokens: { uncached: 0, total: 1, cacheRead: 0, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: 0 }
        },
        response: undefined
      };
  }
};

export const createMockLLMLayer = (
  responses: TurnResponse[],
  onStreamTextCall?: (prompt: Prompt.RawInput) => void
): Layer.Layer<LanguageModel.LanguageModel> => {
  let turnIndex = 0;

  const service = LanguageModel.make({
    streamText: (params: { prompt: Prompt.RawInput }) => {
      if (onStreamTextCall) {
        onStreamTextCall(params.prompt);
      }
      if (turnIndex >= responses.length) {
        return Stream.empty;
      }
      const response = responses[turnIndex];
      turnIndex++;
      return Stream.fromIterable(response.map(mockPartToEncoded));
    },
    generateText: () => Effect.succeed([])
  });

  return Layer.effect(LanguageModel.LanguageModel, service);
};

export interface StubToolkit {
  layer: Layer.Layer<Tool.HandlersFor<typeof AgenticToolkit.tools>, never, ApprovalGate>;
  calls: Record<string, JsonValue[]>;
}

export const createStubToolkit = (overrides?: Record<string, string | Error>): StubToolkit => {
  const calls: Record<string, JsonValue[]> = {};

  const makeHandler =
    <A>(toolName: string, defaultResult: A) =>
    (_params: JsonValue, _context: Toolkit.HandlerContext<Tool.Any>): Effect.Effect<A, AiError.AiError, never> => {
      if (!calls[toolName]) {
        calls[toolName] = [];
      }
      calls[toolName].push(_params);

      const override = overrides?.[toolName];
      if (override instanceof Error) {
        return Effect.fail(
          AiError.make({
            module: toolName,
            method: "handler",
            reason: new AiError.UnknownError({ description: override.message })
          })
        );
      }
      return Effect.succeed(defaultResult);
    };

  const layer = AgenticToolkit.toLayer(
    Effect.gen(function* () {
      const gate = yield* ApprovalGate;
      return {
        shell: withApproval("shell", gate, makeHandler("shell", "stub shell result")),
        read: withApproval("read", gate, makeHandler("read", "stub read result")),
        write: withApproval("write", gate, makeHandler("write", "stub write result")),
        edit: withApproval("edit", gate, makeHandler("edit", "stub edit result")),
        grep: withApproval("grep", gate, makeHandler("grep", ["stub grep result"])),
        glob: withApproval("glob", gate, makeHandler("glob", ["stub glob result"])),
        webfetch: withApproval("webfetch", gate, makeHandler("webfetch", "stub webfetch result")),
        ask_user: withApproval("ask_user", gate, makeHandler("ask_user", "stub ask result")),
        load_skill: withApproval("load_skill", gate, makeHandler("load_skill", "stub load_skill result"))
      };
    })
  ).pipe(Layer.provide(EmptySkillsRepoLayer));

  return { layer, calls };
};

export const createTestConfig = (overrides?: Partial<ConfigData>): ConfigData => ({
  provider: {
    type: "openai-compat" as const,
    apiKey: "test-key",
    baseUrl: "http://localhost:0",
    model: "test-model"
  },
  approvalMode: "none",
  maxTurns: 10,
  systemPrompt: undefined,
  ...overrides
});

export const createTestSession = (id: string, messages?: Message[]): Session =>
  Schema.decodeUnknownSync(SessionSchema)({
    id,
    messages: messages ?? [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

export type MockOpenAIResponse =
  | { type: "text"; content: string }
  | { type: "tool-call"; id: string; name: string; arguments: JsonValue };

const buildSSEChunks = (responses: MockOpenAIResponse[]): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const response of responses) {
    if (response.type === "text") {
      const chunk = `data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: Date.now(),
        model: "test-model",
        choices: [{ index: 0, delta: { content: response.content }, finish_reason: null }]
      })}\n\n`;
      chunks.push(encoder.encode(chunk));
    } else if (response.type === "tool-call") {
      const chunk = `data: ${JSON.stringify({
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
                  id: response.id,
                  type: "function",
                  function: { name: response.name, arguments: JSON.stringify(response.arguments) }
                }
              ]
            },
            finish_reason: null
          }
        ]
      })}\n\n`;
      chunks.push(encoder.encode(chunk));
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

const buildResponseObject = (responseId: string, status: "in_progress" | "completed") => ({
  metadata: null,
  temperature: null,
  top_p: null,
  model: "gpt-4o",
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

const buildResponsesSSEChunks = (responses: MockOpenAIResponse[]): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  const responseId = `resp_mock_${Date.now()}`;
  let seq = 0;

  // response.created event
  const createdEvent = `event: response.created\ndata: ${JSON.stringify({
    type: "response.created",
    sequence_number: seq++,
    response: buildResponseObject(responseId, "in_progress")
  })}\n\n`;
  chunks.push(encoder.encode(createdEvent));

  let outputIndex = 0;

  for (const response of responses) {
    if (response.type === "text") {
      const itemId = `item_text_${outputIndex}`;
      // response.output_item.added
      const outputItemAdded = `event: response.output_item.added\ndata: ${JSON.stringify({
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
      })}\n\n`;
      chunks.push(encoder.encode(outputItemAdded));

      // response.content_part.added
      const contentPartAdded = `event: response.content_part.added\ndata: ${JSON.stringify({
        type: "response.content_part.added",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        sequence_number: seq++,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] }
      })}\n\n`;
      chunks.push(encoder.encode(contentPartAdded));

      // response.output_text.delta
      const textDeltaEvent = `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        delta: response.content,
        sequence_number: seq++,
        logprobs: []
      })}\n\n`;
      chunks.push(encoder.encode(textDeltaEvent));

      // response.output_text.done
      const textDone = `event: response.output_text.done\ndata: ${JSON.stringify({
        type: "response.output_text.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text: response.content,
        sequence_number: seq++,
        logprobs: []
      })}\n\n`;
      chunks.push(encoder.encode(textDone));

      // response.content_part.done
      const contentPartDone = `event: response.content_part.done\ndata: ${JSON.stringify({
        type: "response.content_part.done",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        sequence_number: seq++,
        part: { type: "output_text", text: response.content, annotations: [], logprobs: [] }
      })}\n\n`;
      chunks.push(encoder.encode(contentPartDone));

      // response.output_item.done
      const outputItemDone = `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: outputIndex,
        sequence_number: seq++,
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: response.content, annotations: [], logprobs: [] }],
          status: "completed"
        }
      })}\n\n`;
      chunks.push(encoder.encode(outputItemDone));

      outputIndex++;
    } else if (response.type === "tool-call") {
      const itemId = response.id;
      // response.output_item.added
      const outputItemAdded = `event: response.output_item.added\ndata: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: outputIndex,
        sequence_number: seq++,
        item: {
          id: itemId,
          type: "function_call",
          call_id: itemId,
          name: response.name,
          arguments: ""
        }
      })}\n\n`;
      chunks.push(encoder.encode(outputItemAdded));

      // response.function_call_arguments.done
      const funcCallDone = `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id: itemId,
        output_index: outputIndex,
        sequence_number: seq++,
        name: response.name,
        arguments: JSON.stringify(response.arguments)
      })}\n\n`;
      chunks.push(encoder.encode(funcCallDone));

      // response.output_item.done
      const outputItemDone = `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: outputIndex,
        sequence_number: seq++,
        item: {
          id: itemId,
          type: "function_call",
          call_id: itemId,
          name: response.name,
          arguments: JSON.stringify(response.arguments)
        }
      })}\n\n`;
      chunks.push(encoder.encode(outputItemDone));

      outputIndex++;
    }
  }

  // response.completed event
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

export const createMockOpenAIServer = (
  responses: MockOpenAIResponse[][]
): Effect.Effect<{ url: string; calls: JsonValue[] }, never, Scope.Scope> => {
  const calls: JsonValue[] = [];
  let responseIndex = 0;

  const routeEffect = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json;
    const decodedBody = yield* Schema.decodeUnknownEffect(Schema.Json)(body);
    calls.push(decodedBody);

    if (responseIndex >= responses.length) {
      responseIndex = responses.length - 1;
    }
    const currentResponses = responses[responseIndex];
    responseIndex++;

    const chunks = buildSSEChunks(currentResponses);
    const stream = Stream.fromIterable(chunks);
    return HttpServerResponse.stream(stream, { contentType: "text/event-stream" });
  });

  const responsesRouteEffect = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json;
    const decodedBody = yield* Schema.decodeUnknownEffect(Schema.Json)(body);
    calls.push(decodedBody);

    if (responseIndex >= responses.length) {
      responseIndex = responses.length - 1;
    }
    const currentResponses = responses[responseIndex];
    responseIndex++;

    const chunks = buildResponsesSSEChunks(currentResponses);
    const stream = Stream.fromIterable(chunks);
    return HttpServerResponse.stream(stream, { contentType: "text/event-stream" });
  });

  const chatCompletionsLayer = HttpRouter.add("POST", "/v1/chat/completions", routeEffect);
  const responsesLayer = HttpRouter.add("POST", "/v1/responses", responsesRouteEffect);
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
