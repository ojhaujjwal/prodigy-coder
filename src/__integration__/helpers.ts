import { Context, Effect, Layer, Scope, Stream } from "effect";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Response from "effect/unstable/ai/Response";
import * as AiError from "effect/unstable/ai/AiError";
import { Tool } from "effect/unstable/ai";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import type { ConfigData } from "../config.ts";
import type { Session, Message } from "../session.ts";
import { MyToolkit, withApproval } from "../tools/index.ts";

export type MockPart =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; id: string; name: string; params: unknown }
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
  onStreamTextCall?: (prompt: unknown) => void
): Layer.Layer<LanguageModel.LanguageModel> => {
  let turnIndex = 0;

  const service = LanguageModel.make({
    streamText: (params: { prompt: unknown }) => {
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
  layer: Layer.Layer<Tool.HandlersFor<typeof MyToolkit.tools>>;
  calls: Record<string, unknown[]>;
}

export const createStubToolkit = (
  overrides?: Record<string, string | Error>,
  config?: { approvalMode: "none" | "dangerous" | "all"; nonInteractive: boolean }
): StubToolkit => {
  const calls: Record<string, unknown[]> = {};

  const makeHandler = <A>(toolName: string, defaultResult: A) => {
    return (_params: unknown, _context: unknown): Effect.Effect<A, AiError.AiError, never> => {
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
      if (override !== undefined) {
        // oxlint-disable-next-line typescript/consistent-type-assertions
        return Effect.succeed(override as unknown as A);
      }
      return Effect.succeed(defaultResult);
    };
  };

  const toolConfig = config ?? { approvalMode: "none" as const, nonInteractive: false };

  const layer = MyToolkit.toLayer({
    shell: withApproval("shell", toolConfig, makeHandler("shell", "stub shell result")),
    read: withApproval("read", toolConfig, makeHandler("read", "stub read result")),
    write: withApproval("write", toolConfig, makeHandler("write", "stub write result")),
    edit: withApproval("edit", toolConfig, makeHandler("edit", "stub edit result")),
    grep: withApproval("grep", toolConfig, makeHandler("grep", ["stub grep result"])),
    glob: withApproval("glob", toolConfig, makeHandler("glob", ["stub glob result"])),
    webfetch: withApproval("webfetch", toolConfig, makeHandler("webfetch", "stub webfetch result")),
    ask_user: withApproval("ask_user", toolConfig, makeHandler("ask_user", "stub ask result"))
  });

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

export const createTestSession = (messages?: Message[]): Session => ({
  id: crypto.randomUUID(),
  messages: messages ?? [],
  createdAt: new Date(),
  updatedAt: new Date()
});

export type MockOpenAIResponse =
  | { type: "text"; content: string }
  | { type: "tool-call"; id: string; name: string; arguments: Record<string, unknown> };

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
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: response.id,
              type: "function",
              function: { name: response.name, arguments: JSON.stringify(response.arguments) }
            }]
          },
          finish_reason: null
        }]
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

export const createMockOpenAIServer = (
  responses: MockOpenAIResponse[][]
): Effect.Effect<{ url: string; calls: unknown[] }, never, Scope.Scope> => {
  const calls: unknown[] = [];
  let responseIndex = 0;

  const routeEffect = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json;
    calls.push(body);

    if (responseIndex >= responses.length) {
      responseIndex = responses.length - 1;
    }
    const currentResponses = responses[responseIndex];
    responseIndex++;

    const chunks = buildSSEChunks(currentResponses);
    const stream = Stream.fromIterable(chunks);
    return HttpServerResponse.stream(stream, { contentType: "text/event-stream" });
  });

  const appLayer = HttpRouter.add("POST", "/v1/chat/completions", routeEffect);

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
