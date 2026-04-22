import { Effect, Layer, Stream } from "effect";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Response from "effect/unstable/ai/Response";
import * as AiError from "effect/unstable/ai/AiError";
import { Tool } from "effect/unstable/ai";
import type { ConfigData } from "../config.ts";
import type { Session, Message } from "../session.ts";
import { MyToolkit } from "../tools/index.ts";

export type MockPart =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; id: string; name: string; params: unknown }
  | {
      type: "tool-result";
      id: string;
      name: string;
      result: unknown;
      isFailure?: boolean;
      preliminary?: boolean;
    }
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
    case "tool-result":
      return {
        type: "tool-result",
        id: part.id,
        name: part.name,
        result: part.result,
        isFailure: part.isFailure ?? false,
        preliminary: part.preliminary ?? false
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

export const createStubToolkit = (overrides?: Record<string, Error>): StubToolkit => {
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
      return Effect.succeed(defaultResult);
    };
  };

  const layer = MyToolkit.toLayer({
    shell: makeHandler("shell", "stub shell result"),
    read: makeHandler("read", "stub read result"),
    write: makeHandler("write", "stub write result"),
    edit: makeHandler("edit", "stub edit result"),
    grep: makeHandler("grep", ["stub grep result"]),
    glob: makeHandler("glob", ["stub glob result"]),
    webfetch: makeHandler("webfetch", "stub webfetch result")
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

export const createMockOpenAIServer = (
  responses: MockOpenAIResponse[][]
): Effect.Effect<{ url: string; calls: unknown[]; cleanup: () => void }> => {
  const calls: unknown[] = [];
  let responseIndex = 0;

  // oxlint-disable-next-line prodigy/no-bun-globals
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.url.includes("/v1/chat/completions")) {
        const body = await req.json();
        calls.push(body);

        if (responseIndex >= responses.length) {
          responseIndex = responses.length - 1;
        }
        const currentResponses = responses[responseIndex];
        responseIndex++;

        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          async start(controller) {
            for (const response of currentResponses) {
              if (response.type === "text") {
                const chunk = `data: ${JSON.stringify({
                  id: "chatcmpl-mock",
                  object: "chat.completion.chunk",
                  created: Date.now(),
                  model: "test-model",
                  choices: [
                    {
                      index: 0,
                      delta: { content: response.content },
                      finish_reason: null
                    }
                  ]
                })}\n\n`;
                controller.enqueue(encoder.encode(chunk));
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
                            function: {
                              name: response.name,
                              arguments: JSON.stringify(response.arguments)
                            }
                          }
                        ]
                      },
                      finish_reason: null
                    }
                  ]
                })}\n\n`;
                controller.enqueue(encoder.encode(chunk));
              }
            }

            const finishChunk = `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              created: Date.now(),
              model: "test-model",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop"
                }
              ]
            })}\n\n`;
            controller.enqueue(encoder.encode(finishChunk));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        });

        return new globalThis.Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          }
        });
      }
      return new globalThis.Response("Not found", { status: 404 });
    }
  });

  return Effect.sync(() => ({
    url: `http://localhost:${server.port}/v1`,
    calls,
    cleanup: () => server.stop()
  }));
};
