import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { runAgent, type AgentConfig } from "../agent.ts";
import {
  createMockLLMLayer,
  createStubToolkit,
  createTestConfig,
  createTestSession,
  type TurnResponse
} from "./helpers.ts";
import { SessionRepo } from "../session.ts";
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices";

const testLayer = SessionRepo.layer.pipe(Layer.provide(bunServicesLayer));

describe("e2e", () => {
  it.effect("Test 1: Agent with mock LLM produces output events", () =>
    Effect.gen(function* () {
      const mockResponses: TurnResponse[] = [
        [
          { type: "text-delta", delta: "Hello from mock!" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const config = createTestConfig();
      const session = createTestSession();
      const { layer } = createStubToolkit();

      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const textDeltas = result.filter((e) => e.type === "text-delta");
      const finishes = result.filter((e) => e.type === "finish");

      expect(textDeltas.length >= 1).toBe(true);
      expect(finishes.length >= 1).toBe(true);
    })
  );

  it.effect("Test 2: Session repo can list sessions", () =>
    Effect.gen(function* () {
      const repo = yield* SessionRepo;
      const sessions = yield* repo.list();

      expect(Array.isArray(sessions)).toBe(true);
    }).pipe(Effect.provide(testLayer))
  );

  it.effect("Test 3: Session accumulates messages after agent run", () =>
    Effect.gen(function* () {
      const mockResponses: TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [
          { type: "text-delta", delta: "Done" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const { layer } = createStubToolkit();

      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      expect(agentConfig.session.messages.length >= 2).toBe(true);
    })
  );

  it.effect("Test 4: Multiple tool calls in sequence", () =>
    Effect.gen(function* () {
      const mockResponses: TurnResponse[] = [
        [
          { type: "tool-call", id: "call-1", name: "read", params: { filePath: "/a.txt" } },
          { type: "tool-call", id: "call-2", name: "write", params: { filePath: "/b.txt", content: "test" } }
        ],
        [{ type: "finish", reason: "stop" }]
      ];

      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const { layer, calls } = createStubToolkit();

      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      expect(calls["read"]).toEqual([{ filePath: "/a.txt" }]);
      expect(calls["write"]).toEqual([{ filePath: "/b.txt", content: "test" }]);
    })
  );
});
