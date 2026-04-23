import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { runAgent, type AgentConfig } from "../agent.ts";
import { buildProviderLayer } from "../provider.ts";
import { createMockOpenAIServer, createTestConfig, createTestSession } from "./helpers.ts";
import { MyToolkitLayer } from "../tools/index.ts";
import { BunServices } from "@effect/platform-bun";

describe("provider e2e", () => {
  it.effect("receives text response from mock OpenAI server", () =>
    Effect.gen(function* () {
      const server = yield* createMockOpenAIServer([[{ type: "text", content: "Hello from server" }]]);

      const config = createTestConfig({
        provider: {
          type: "openai-compat" as const,
          apiKey: "test",
          baseUrl: server.url,
          model: "test-model"
        }
      });

      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };

      const providerLayer = Layer.merge(buildProviderLayer(config.provider), MyToolkitLayer).pipe(
        Layer.provide(FetchHttpClient.layer)
      );

      const result = yield* runAgent("test", agentConfig, providerLayer);

      const textDeltas = result.filter((e) => e.type === "text-delta");
      const finishes = result.filter((e) => e.type === "finish");

      expect(textDeltas.length).toBeGreaterThan(0);
      expect(textDeltas.some((e) => e.delta.includes("Hello from server"))).toBe(true);
      expect(finishes.length).toBe(1);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("receives tool-call response from mock OpenAI server", () =>
    Effect.gen(function* () {
      const server = yield* createMockOpenAIServer([
        [
          {
            type: "tool-call",
            id: "call-1",
            name: "shell",
            arguments: { command: "echo e2e-test" }
          }
        ],
        [{ type: "text", content: "Done" }]
      ]);

      const config = createTestConfig({
        provider: {
          type: "openai-compat" as const,
          apiKey: "test",
          baseUrl: server.url,
          model: "test-model"
        },
        approvalMode: "none"
      });

      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };

      const providerLayer = Layer.merge(buildProviderLayer(config.provider), MyToolkitLayer).pipe(
        Layer.provide(FetchHttpClient.layer)
      );

      const result = yield* runAgent("test", agentConfig, providerLayer);

      const toolCalls = result.filter((e) => e.type === "tool-call");
      const toolResults = result.filter((e) => e.type === "tool-result");
      const finishes = result.filter((e) => e.type === "finish");

      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].name).toBe("shell");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].result).toContain("e2e-test");
      expect(finishes.length).toBe(1);
    }).pipe(Effect.provide(BunServices.layer))
  );
});
