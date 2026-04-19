import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { runAgent, type AgentConfig } from "../agent.ts"
import {
  createMockLLMLayer,
  createStubHandlers,
  createTestConfig,
  createTestSession,
} from "./helpers.ts"

class TestError extends Error {
  readonly _tag = "TestError"
}

const runAgentWithMocks = (
  mockResponses: import("./helpers.ts").TurnResponse[],
  configOverrides?: Partial<import("../config.ts").ConfigData>,
  sessionMessages?: import("../session.ts").Message[]
) => {
  const config = createTestConfig(configOverrides)
  const session = createTestSession(sessionMessages)
  const { handlers } = createStubHandlers()

  const agentConfig: AgentConfig = {
    session,
    config,
    handlers,
  }

  const mockLLMLayer = createMockLLMLayer(mockResponses)

  return runAgent("test prompt", agentConfig, mockLLMLayer)
}

describe("agent integration", () => {
  it.effect("Test 1: Text-only response", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "text-delta", delta: "Hello, world!" },
          { type: "finish", reason: "stop" },
        ],
      ]

      const result = yield* runAgentWithMocks(mockResponses)

      const textDeltas = result.filter((e) => e.type === "text-delta")
      const finishes = result.filter((e) => e.type === "finish")
      const toolCalls = result.filter((e) => e.type === "tool-call")
      const toolResults = result.filter((e) => e.type === "tool-result")

      assert.equal(textDeltas.length, 1)
      assert.equal(textDeltas[0].delta, "Hello, world!")
      assert.equal(finishes.length, 1)
      assert.equal(toolCalls.length, 0)
      assert.equal(toolResults.length, 0)
    })

  )

  it.skip("Test 2: Single tool call then finish", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [
          { type: "text-delta", delta: "Done" },
          { type: "finish", reason: "stop" },
        ],
      ]

      const { handlers } = createStubHandlers()
      const config = createTestConfig({ approvalMode: "none" })
      const session = createTestSession()
      const agentConfig: AgentConfig = { session, config, handlers }
      const mockLLMLayer = createMockLLMLayer(mockResponses)

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer)

      const toolCalls = result.filter((e) => e.type === "tool-call")
      const toolResults = result.filter((e) => e.type === "tool-result")
      const finishes = result.filter((e) => e.type === "finish")

      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0].name, "read")
      assert.equal(toolResults.length, 1)
      assert.equal(toolResults[0].isError, false)
      assert.equal(toolResults[0].result, "stub read result")
      assert.equal(finishes.length, 1)
    })

  )

  it.skip("Test 3: Two tool calls in one turn", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "tool-call", id: "call-1", name: "read", params: { filePath: "/a" } },
          { type: "tool-call", id: "call-2", name: "write", params: { filePath: "/b", content: "x" } },
        ],
        [{ type: "finish", reason: "stop" }],
      ]

      const { handlers, calls } = createStubHandlers()
      const config = createTestConfig({ approvalMode: "none" })
      const session = createTestSession()
      const agentConfig: AgentConfig = { session, config, handlers }
      const mockLLMLayer = createMockLLMLayer(mockResponses)

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer)

      const toolCalls = result.filter((e) => e.type === "tool-call")
      const toolResults = result.filter((e) => e.type === "tool-result")

      assert.equal(toolCalls.length, 2)
      assert.equal(toolResults.length, 2)

      assert.deepEqual(calls["read"], [{ filePath: "/a" }])
      assert.deepEqual(calls["write"], [{ filePath: "/b", content: "x" }])
    })

  )

  it.skip("Test 4: Unknown tool", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "nonexistent", params: { foo: "bar" } }],
        [{ type: "finish", reason: "stop" }],
      ]

      const { handlers } = createStubHandlers()
      const config = createTestConfig({ approvalMode: "none" })
      const session = createTestSession()
      const agentConfig: AgentConfig = { session, config, handlers }
      const mockLLMLayer = createMockLLMLayer(mockResponses)

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer)

      const toolResults = result.filter((e) => e.type === "tool-result")

      assert.equal(toolResults.length, 1)
      assert.equal(toolResults[0].isError, true)
      assert.include(toolResults[0].result, "Unknown tool: nonexistent")
    })

  )

  it.skip("Test 5: Tool execution error", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/bad" } }],
        [{ type: "finish", reason: "stop" }],
      ]

      const { handlers } = createStubHandlers({ read: new TestError("file not found") })
      const config = createTestConfig({ approvalMode: "none" })
      const session = createTestSession()
      const agentConfig: AgentConfig = { session, config, handlers }
      const mockLLMLayer = createMockLLMLayer(mockResponses)

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer)

      const toolResults = result.filter((e) => e.type === "tool-result")

      assert.equal(toolResults.length, 1)
      assert.equal(toolResults[0].isError, true)
      assert.include(toolResults[0].result, "file not found")
    })

  )

  it.skip("Test 6: approvalMode none", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "shell", params: { command: "ls" } }],
        [{ type: "finish", reason: "stop" }],
      ]

      const { handlers } = createStubHandlers()
      const config = createTestConfig({ approvalMode: "none" })
      const session = createTestSession()
      const agentConfig: AgentConfig = { session, config, handlers }
      const mockLLMLayer = createMockLLMLayer(mockResponses)

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer)

      const approvalRequests = result.filter((e) => e.type === "tool-approval-request")

      assert.equal(approvalRequests.length, 0)
    })

  )

  it.skip("Test 7: approvalMode dangerous", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "tool-call", id: "call-1", name: "shell", params: { command: "ls" } },
          { type: "tool-call", id: "call-2", name: "read", params: { filePath: "/test.txt" } },
        ],
        [{ type: "finish", reason: "stop" }],
      ]

      const { handlers } = createStubHandlers()
      const config = createTestConfig({ approvalMode: "dangerous" })
      const session = createTestSession()
      const agentConfig: AgentConfig = { session, config, handlers }
      const mockLLMLayer = createMockLLMLayer(mockResponses)

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer)

      const approvalRequests = result.filter((e) => e.type === "tool-approval-request")

      assert.equal(approvalRequests.length, 1)
      assert.equal(approvalRequests[0].toolName, "shell")
    })

  )

  it.skip("Test 8: maxTurns 1 with tool call", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
      ]

      const { handlers } = createStubHandlers()
      const config = createTestConfig({ maxTurns: 1 })
      const session = createTestSession()
      const agentConfig: AgentConfig = { session, config, handlers }
      const mockLLMLayer = createMockLLMLayer(mockResponses)

      const result = yield* runAgent("test prompt", agentConfig, mockLLMLayer)

      const errors = result.filter((e) => e.type === "error")

      assert.equal(errors.length, 1)
      assert.include(errors[0].message, "Max turns exceeded")
    })

  )

  it.skip("Test 9: System prompt prepended", () =>
    Effect.gen(function* () {
      const capturedPrompts: unknown[] = []

      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "text-delta", delta: "Hi" },
          { type: "finish", reason: "stop" },
        ],
      ]

      const { handlers } = createStubHandlers()
      const config = createTestConfig({ systemPrompt: "You are a helpful assistant." })
      const session = createTestSession()
      const agentConfig: AgentConfig = { session, config, handlers }
      const mockLLMLayer = createMockLLMLayer(mockResponses, (prompt) => {
        capturedPrompts.push(prompt)
      })

      yield* runAgent("test prompt", agentConfig, mockLLMLayer)

      assert.equal(capturedPrompts.length, 1)
      const prompt = capturedPrompts[0] as Array<{ role: string; content: string }>
      assert.isTrue(prompt.some((m) => m.role === "system" && m.content.includes("You are a helpful assistant")))
    })

  )

  it.skip("Test 10: Session messages accumulate", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [
          { type: "text-delta", delta: "Done" },
          { type: "finish", reason: "stop" },
        ],
      ]

      const { handlers } = createStubHandlers()
      const config = createTestConfig({ approvalMode: "none" })
      const session = createTestSession()
      const agentConfig: AgentConfig = { session, config, handlers }

      const mockLLMLayer = createMockLLMLayer(mockResponses)

      yield* runAgent("test prompt", agentConfig, mockLLMLayer)

      assert.isTrue(agentConfig.session.messages.length >= 2)
      assert.isTrue(agentConfig.session.messages.some((m) => m.role === "user"))
    })

  )
})
