import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { runAgent, type AgentConfig } from "../agent.ts";
import { createMockLLMLayer, createStubHandlers, createTestConfig, createTestSession } from "./helpers.ts";

class TestError extends Error {
  readonly _tag = "TestError";
}

const runAgentWithMocks = (
  mockResponses: import("./helpers.ts").TurnResponse[],
  configOverrides?: Partial<import("../config.ts").ConfigData>,
  sessionMessages?: import("../session.ts").Message[]
) => {
  const config = createTestConfig(configOverrides);
  const session = createTestSession(sessionMessages);
  const { handlers } = createStubHandlers();

  const agentConfig: AgentConfig = {
    session,
    config,
    handlers
  };

  const mockLLMLayer = createMockLLMLayer(mockResponses);

  return runAgent("test prompt", agentConfig, mockLLMLayer);
};

describe("agent integration", () => {
  it.effect("Test 1: Text-only response", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "text-delta", delta: "Hello, world!" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const result = yield* runAgentWithMocks(mockResponses);

      const textDeltas = result.filter((e) => e.type === "text-delta");
      const finishes = result.filter((e) => e.type === "finish");
      const toolCalls = result.filter((e) => e.type === "tool-call");
      const toolResults = result.filter((e) => e.type === "tool-result");

      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].delta).toBe("Hello, world!");
      expect(finishes.length).toBe(1);
      expect(toolCalls.length).toBe(0);
      expect(toolResults.length).toBe(0);
    })
  );

  it.effect("Test 2: Single tool call then finish", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [
          { type: "text-delta", delta: "Done" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const { handlers } = createStubHandlers();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config, handlers };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer);

      const toolCalls = result.filter((e) => e.type === "tool-call");
      const toolResults = result.filter((e) => e.type === "tool-result");
      const finishes = result.filter((e) => e.type === "finish");

      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].name).toBe("read");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].isError).toBe(false);
      expect(toolResults[0].result).toBe("stub read result");
      expect(finishes.length).toBe(1);
    })
  );

  it.effect("Test 3: Two tool calls in one turn", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "tool-call", id: "call-1", name: "read", params: { filePath: "/a" } },
          { type: "tool-call", id: "call-2", name: "write", params: { filePath: "/b", content: "x" } }
        ],
        [{ type: "finish", reason: "stop" }]
      ];

      const { handlers, calls } = createStubHandlers();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config, handlers };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer);

      const toolCalls = result.filter((e) => e.type === "tool-call");
      const toolResults = result.filter((e) => e.type === "tool-result");

      expect(toolCalls.length).toBe(2);
      expect(toolResults.length).toBe(2);

      expect(calls["read"]).toEqual([{ filePath: "/a" }]);
      expect(calls["write"]).toEqual([{ filePath: "/b", content: "x" }]);
    })
  );

  it.effect("Test 4: Unknown tool", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [{ type: "finish", reason: "stop" }]
      ];

      const { handlers } = createStubHandlers({ read: new TestError("handler removed") });
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config, handlers };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer);

      const toolResults = result.filter((e) => e.type === "tool-result");

      expect(toolResults.length).toBe(1);
      expect(toolResults[0].isError).toBe(true);
      expect(toolResults[0].result).toContain("handler removed");
    })
  );

  it.effect("Test 5: Tool execution error", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/bad" } }],
        [{ type: "finish", reason: "stop" }]
      ];

      const { handlers } = createStubHandlers({ read: new TestError("file not found") });
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config, handlers };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer);

      const toolResults = result.filter((e) => e.type === "tool-result");

      expect(toolResults.length).toBe(1);
      expect(toolResults[0].isError).toBe(true);
      expect(toolResults[0].result).toContain("file not found");
    })
  );

  it.effect("Test 6: approvalMode none", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "shell", params: { command: "ls" } }],
        [{ type: "finish", reason: "stop" }]
      ];

      const { handlers } = createStubHandlers();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config, handlers };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer);

      const approvalRequests = result.filter((e) => e.type === "tool-approval-request");

      expect(approvalRequests.length).toBe(0);
    })
  );

  it.effect("Test 7: approvalMode dangerous", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "tool-call", id: "call-1", name: "shell", params: { command: "ls" } },
          { type: "tool-call", id: "call-2", name: "read", params: { filePath: "/test.txt" } }
        ],
        [{ type: "finish", reason: "stop" }]
      ];

      const { handlers } = createStubHandlers();
      const config = createTestConfig({ approvalMode: "dangerous" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config, handlers };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer);

      const approvalRequests = result.filter((e) => e.type === "tool-approval-request");

      expect(approvalRequests.length).toBe(1);
      expect(approvalRequests[0].toolName).toBe("shell");
    })
  );

  it.effect("Test 8: maxTurns 1 with tool call", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }]
      ];

      const { handlers } = createStubHandlers();
      const config = createTestConfig({ maxTurns: 1 });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config, handlers };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer);

      const errors = result.filter((e) => e.type === "error");

      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain("Max turns exceeded");
    })
  );

  it.effect("Test 9: System prompt prepended", () =>
    Effect.gen(function* () {
      const capturedPrompts: unknown[] = [];

      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "text-delta", delta: "Hi" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const { handlers } = createStubHandlers();
      const config = createTestConfig({ systemPrompt: "You are a helpful assistant." });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config, handlers };
      const mockLLMLayer = createMockLLMLayer(mockResponses, (prompt) => {
        capturedPrompts.push(prompt);
      });

      yield* runAgent("test prompt", agentConfig, mockLLMLayer);

      expect(capturedPrompts.length).toBe(1);
      const prompt = capturedPrompts[0] as { content: Array<{ role: string; content: unknown }> };
      expect(
        prompt.content.some(
          (m) =>
            m.role === "system" && typeof m.content === "string" && m.content.includes("You are a helpful assistant")
        )
      ).toBe(true);
    })
  );

  it.effect("Test 10: Session messages accumulate", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [
          { type: "text-delta", delta: "Done" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const { handlers } = createStubHandlers();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config, handlers };

      const mockLLMLayer = createMockLLMLayer(mockResponses);

      yield* runAgent("test prompt", agentConfig, mockLLMLayer);

      expect(agentConfig.session.messages.length >= 2).toBe(true);
      expect(agentConfig.session.messages.some((m) => m.role === "user")).toBe(true);
    })
  );
});
