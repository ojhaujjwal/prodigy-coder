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
import { BunServices } from "@effect/platform-bun";

const testLayer = SessionRepo.layer.pipe(Layer.provide(BunServices.layer));

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
    }).pipe(Effect.provide(BunServices.layer))
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
    }).pipe(Effect.provide(BunServices.layer))
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
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("Test 5: Tool call followed by text response in next turn", () =>
    Effect.gen(function* () {
      const mockResponses: TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "glob", params: { pattern: "*.ts", path: "." } }],
        [
          { type: "text-delta", delta: "Found the files" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const { layer, calls } = createStubToolkit();

      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("find ts files", agentConfig, Layer.merge(mockLLMLayer, layer));

      expect(calls["glob"]).toEqual([{ pattern: "*.ts", path: "." }]);

      const toolResults = result.filter((e) => e.type === "tool-result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].type === "tool-result" && toolResults[0].name).toBe("glob");

      const textDeltas = result.filter((e) => e.type === "text-delta");
      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].type === "text-delta" && textDeltas[0].delta).toBe("Found the files");

      const finishes = result.filter((e) => e.type === "finish");
      expect(finishes.length).toBe(1);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("Test 6: Session accumulates tool result messages", () =>
    Effect.gen(function* () {
      const mockResponses: TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [
          { type: "text-delta", delta: "File read successfully" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const { layer } = createStubToolkit();

      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      yield* runAgent("read the file", agentConfig, Layer.merge(mockLLMLayer, layer));

      const assistantMessages = session.messages.filter((m) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("Test 7: Multiple sequential tool calls across turns", () =>
    Effect.gen(function* () {
      const mockResponses: TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "glob", params: { pattern: "src/*.ts", path: "." } }],
        [{ type: "tool-call", id: "call-2", name: "read", params: { filePath: "src/index.ts" } }],
        [
          { type: "text-delta", delta: "Analysis complete" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const { layer, calls } = createStubToolkit();

      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("analyze code", agentConfig, Layer.merge(mockLLMLayer, layer));

      expect(calls["glob"]).toEqual([{ pattern: "src/*.ts", path: "." }]);
      expect(calls["read"]).toEqual([{ filePath: "src/index.ts" }]);

      const toolResults = result.filter((e) => e.type === "tool-result");
      expect(toolResults.length).toBe(2);

      const finishes = result.filter((e) => e.type === "finish");
      expect(finishes.length).toBe(1);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("Test 8: Tool call with failure result", () =>
    Effect.gen(function* () {
      const mockResponses: TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "webfetch", params: { url: "http://bad-url" } }],
        [
          { type: "text-delta", delta: "Failed to fetch" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const { layer } = createStubToolkit({ webfetch: new Error("network error") });

      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("fetch url", agentConfig, Layer.merge(mockLLMLayer, layer));

      const toolResults = result.filter((e) => e.type === "tool-result");
      expect(toolResults.length).toBe(1);
      if (toolResults[0].type === "tool-result") {
        expect(toolResults[0].isError).toBe(true);
      }
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("Test 9: Tool call with finish:tool-calls in same response ", () =>
    Effect.gen(function* () {
      const mockResponses: TurnResponse[] = [
        [
          { type: "tool-call", id: "call-1", name: "glob", params: { pattern: "*.ts", path: "." } },
          { type: "finish", reason: "tool-calls" }
        ],
        [
          { type: "text-delta", delta: "Found these TypeScript files" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const { layer, calls } = createStubToolkit();

      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("find ts files", agentConfig, Layer.merge(mockLLMLayer, layer));

      expect(calls["glob"]).toEqual([{ pattern: "*.ts", path: "." }]);

      const toolResults = result.filter((e) => e.type === "tool-result");
      expect(toolResults.length).toBe(1);

      const textDeltas = result.filter((e) => e.type === "text-delta");
      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].type === "text-delta" && textDeltas[0].delta).toBe("Found these TypeScript files");

      const finishes = result.filter((e) => e.type === "finish");
      expect(finishes.length).toBeGreaterThanOrEqual(1);
      const lastFinish = finishes[finishes.length - 1];
      expect(lastFinish.type === "finish" && lastFinish.text).toBe("stop");
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("Test 10: Session messages split tool-call and tool-result into separate messages", () =>
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

      yield* runAgent("read the file", agentConfig, Layer.merge(mockLLMLayer, layer));

      const assistantMessages = session.messages.filter((m) => m.role === "assistant");
      const toolMessages = session.messages.filter((m) => m.role === "tool");

      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
      expect(toolMessages.length).toBeGreaterThanOrEqual(1);

      const assistantWithToolCall = assistantMessages.find(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "tool-call")
      );
      expect(assistantWithToolCall).toBeDefined();
      if (assistantWithToolCall && Array.isArray(assistantWithToolCall.content)) {
        const hasToolCall = assistantWithToolCall.content.some(
          (part) => part.type === "tool-call" && part.name === "read"
        );
        expect(hasToolCall).toBe(true);
      }

      const toolMsg = toolMessages[toolMessages.length - 1];
      expect(Array.isArray(toolMsg.content)).toBe(true);
      if (Array.isArray(toolMsg.content)) {
        const hasToolResult = toolMsg.content.some((part) => part.type === "tool-result" && part.name === "read");
        expect(hasToolResult).toBe(true);
      }

      const toolCallIndex = session.messages.findIndex(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "tool-call")
      );
      const toolResultIndex = session.messages.findIndex(
        (m) => m.role === "tool" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool-result")
      );
      expect(toolCallIndex).toBeLessThan(toolResultIndex);
    }).pipe(Effect.provide(BunServices.layer))
  );
});
