import { Effect, Layer, Stream } from "effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as Response from "effect/unstable/ai/Response"
import * as AiError from "effect/unstable/ai/AiError"
import type { ConfigData } from "../config.ts"
import type { Session, Message } from "../session.ts"

export type MockPart =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; id: string; name: string; params: unknown }
  | { type: "finish"; reason: string }

export type TurnResponse = MockPart[]

const textDeltaPart = (delta: string): Response.StreamPartEncoded =>
  ({
    type: "text-delta",
    id: "mock-id",
    delta,
  }) as Response.StreamPartEncoded

const toolCallPart = (id: string, name: string, params: unknown): Response.StreamPartEncoded =>
  ({
    type: "tool-call",
    id,
    name,
    params,
    providerExecuted: false,
  }) as Response.StreamPartEncoded

const finishPart = (reason: string): Response.StreamPartEncoded =>
  ({
    type: "finish",
    reason,
    usage: {
      inputTokens: { uncached: 0, total: 1, cacheRead: 0, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  }) as Response.StreamPartEncoded

const mockPartToEncoded = (part: MockPart): Response.StreamPartEncoded => {
  switch (part.type) {
    case "text-delta":
      return textDeltaPart(part.delta)
    case "tool-call":
      return toolCallPart(part.id, part.name, part.params)
    case "finish":
      return finishPart(part.reason)
  }
}

export const createMockLLMLayer = (
  responses: TurnResponse[],
  onStreamTextCall?: (prompt: unknown) => void
): Layer.Layer<LanguageModel.LanguageModel> => {
  let turnIndex = 0

  const service = LanguageModel.make({
    streamText: (params: { prompt: unknown }) => {
      if (onStreamTextCall) {
        onStreamTextCall(params.prompt)
      }
      if (turnIndex >= responses.length) {
        return Stream.empty
      }
      const response = responses[turnIndex]
      turnIndex++
      return Stream.fromIterable(response.map(mockPartToEncoded))
    },
    generateText: () => Effect.succeed([]),
  })

  return Layer.effect(LanguageModel.LanguageModel, service)
}

export interface StubHandlers {
  handlers: Record<string, (params: unknown) => Effect.Effect<string, AiError.AiError>>
  calls: Record<string, unknown[]>
}

export const createStubHandlers = (
  overrides?: Record<string, string | Error>
): StubHandlers => {
  const calls: Record<string, unknown[]> = {}

  const makeHandler = (toolName: string) => {
    return (params: unknown): Effect.Effect<string, AiError.AiError> => {
      if (!calls[toolName]) {
        calls[toolName] = []
      }
      calls[toolName].push(params)

      const override = overrides?.[toolName]
      if (override instanceof Error) {
        return Effect.fail(
          AiError.make({
            module: toolName,
            method: "handler",
            reason: new AiError.UnknownError({ description: override.message }),
          })
        )
      }
      if (override !== undefined) {
        return Effect.succeed(override)
      }
      return Effect.succeed(`stub ${toolName} result`)
    }
  }

  const handlers: Record<string, (params: unknown) => Effect.Effect<string, AiError.AiError>> = {
    shell: makeHandler("shell"),
    read: makeHandler("read"),
    write: makeHandler("write"),
    edit: makeHandler("edit"),
    grep: makeHandler("grep"),
    glob: makeHandler("glob"),
    webfetch: makeHandler("webfetch"),
  }

  return { handlers, calls }
}

export const createTestConfig = (overrides?: Partial<ConfigData>): ConfigData => ({
  provider: {
    type: "openai-compat" as const,
    apiKey: "test-key",
    baseUrl: "http://localhost:0",
    model: "test-model",
  },
  approvalMode: "none",
  maxTurns: 10,
  systemPrompt: undefined,
  ...overrides,
})

export const createTestSession = (messages?: Message[]): Session => ({
  id: crypto.randomUUID(),
  messages: messages ?? [],
  createdAt: new Date(),
  updatedAt: new Date(),
})
