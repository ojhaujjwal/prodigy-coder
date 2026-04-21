import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Response from "effect/unstable/ai/Response";
import * as AiError from "effect/unstable/ai/AiError";
import { runAgent, type AgentConfig } from "../src/agent.ts";
import { MyToolkit } from "../src/tools/index.ts";

const mockLanguageModelLayer = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    streamText: () => {
      const empty: Stream.Stream<Response.StreamPartEncoded, AiError.AiError> = Stream.empty;
      return empty;
    },
    generateText: () => Effect.succeed([])
  })
);

const mockToolkitLayer = MyToolkit.toLayer({
  shell: () => Effect.succeed(""),
  read: () => Effect.succeed(""),
  write: () => Effect.succeed(""),
  edit: () => Effect.succeed(""),
  grep: () => Effect.succeed([]),
  glob: () => Effect.succeed([]),
  webfetch: () => Effect.succeed("")
});

describe("agent", () => {
  it("runAgent should have correct type signature", () => {
    const config = {
      type: "openai-compat" as const,
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o"
    };

    const session = {
      id: "test-session",
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const agentConfig: AgentConfig = {
      session,
      config: {
        provider: config,
        approvalMode: "none",
        maxTurns: 10,
        systemPrompt: undefined
      }
    };

    const result = runAgent("test prompt", agentConfig, Layer.merge(mockLanguageModelLayer, mockToolkitLayer));
    expect(result).toBeDefined();
  });

  it("runAgent should handle empty session with systemPrompt", () => {
    const config = {
      type: "openai-compat" as const,
      apiKey: "test-key",
      model: "gpt-4o"
    };

    const session = {
      id: "test-session",
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const agentConfig: AgentConfig = {
      session,
      config: {
        provider: config,
        approvalMode: "none",
        maxTurns: 5,
        systemPrompt: "You are a helpful assistant."
      }
    };

    const result = runAgent("test prompt", agentConfig, Layer.merge(mockLanguageModelLayer, mockToolkitLayer));
    expect(result).toBeDefined();
  });
});
