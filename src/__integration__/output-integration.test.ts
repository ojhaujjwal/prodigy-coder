import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { runAgent, type AgentConfig } from "../agent.ts";
import type { OutputEvent } from "../output.ts";
import { makeTextFormatter, makeStreamJsonFormatter } from "../output.ts";
import { createMockLLMLayer, createStubToolkit, createTestConfig, createTestSession } from "./helpers.ts";
import { BunServices } from "@effect/platform-bun";

const runAgentWithMocks = (
  mockResponses: import("./helpers.ts").TurnResponse[],
  configOverrides?: Partial<import("../config.ts").ConfigData>
) => {
  const config = createTestConfig(configOverrides);
  const session = createTestSession();
  const { layer } = createStubToolkit();

  const agentConfig: AgentConfig = {
    session,
    config
  };

  const mockLLMLayer = createMockLLMLayer(mockResponses);

  return runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));
};

describe("output integration", () => {
  it.effect("Test 1: Stream-json formatter through agent", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "text-delta", delta: "Hello" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const formatter = makeStreamJsonFormatter();
      const events = yield* runAgentWithMocks(mockResponses);

      for (const event of events) {
        yield* formatter(event);
      }

      expect(events.length >= 2).toBe(true);
      const textDeltas = events.filter((e) => e.type === "text-delta");
      const finishes = events.filter((e) => e.type === "finish");
      expect(textDeltas.length >= 1).toBe(true);
      expect(finishes.length >= 1).toBe(true);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("Test 2: Text formatter through agent", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "text-delta", delta: "Hello, world!" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const formatter = makeTextFormatter();
      const events = yield* runAgentWithMocks(mockResponses);

      for (const event of events) {
        yield* formatter(event);
      }

      const textDeltas = events.filter((e) => e.type === "text-delta");
      expect(textDeltas[0].delta).toBe("Hello, world!");
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("Test 3: All event types produce valid output", () =>
    Effect.gen(function* () {
      const events: OutputEvent[] = [
        { type: "text-delta", delta: "Hello" },
        { type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } },
        { type: "tool-result", id: "call-1", name: "read", result: "file content", isError: false },
        { type: "finish", text: "Done" },
        { type: "error", message: "Failed" }
      ];

      const streamJsonFormatter = makeStreamJsonFormatter();
      const textFormatter = makeTextFormatter();

      for (const event of events) {
        yield* streamJsonFormatter(event);
        yield* textFormatter(event);
      }
    })
  );
});
