# Integration & E2E Tests

## Overview

Wire up the real `runAgent` in `index.ts` (replacing the stub) and create integration/E2E tests that exercise the full agent loop with a mocked LLM and stubbed tool handlers, ensuring the CLI-to-agent-to-output pipeline works end-to-end.

## Background

The current `index.ts` has a stub `runAgent` that prints a placeholder message and exits. The real `runAgent` in `agent.ts` processes LLM responses, dispatches tool calls, manages sessions, and emits `OutputEvent`s. Integration tests are configured in `vitest.config.ts` under the `"integration"` project matching `src/__integration__/**/*.test.ts`, but no such directory or tests exist yet. The agent loop uses `disableToolCallResolution: true` and manually dispatches tool calls through a `handlers` record — this design makes it straightforward to stub handlers for testing.

## Requirements

- [x] Replace stub `runAgent` in `index.ts` with real agent loop wiring (provider layer + handlers + formatter)
- [x] Create `src/__integration__/` directory with test helpers
- [x] Mock LLM layer that returns configurable multi-turn responses
- [x] Stub tool handlers that record calls and return configurable results
- [x] Agent loop integration tests covering: text-only, tool calls, approval modes, max turns, errors
- [x] Output formatter integration tests covering: stream-json through agent, text through agent, all event types
- [x] Full E2E tests with mock OpenAI-compatible HTTP server exercising CLI → provider → agent → tools → output
- [x] All tests must pass `bun vitest run` (both unit and integration projects)

## Tasks

- [x] **Task 1**: Wire up real `runAgent` in `index.ts`
- [x] **Task 2**: Create test helpers and basic agent integration tests
- [x] **Task 3**: Add agent integration tests for policy scenarios (approval, max turns, system prompt, session)
- [x] **Task 4**: Add output integration tests
- [x] **Task 5**: Add E2E tests with mock OpenAI-compatible HTTP server

## Implementation Details

### Task 1: Wire up real `runAgent` in `index.ts`

Replace the current stub `runAgent` in `src/index.ts` with a real implementation that connects the CLI to the agent loop. This is the critical wiring that makes the CLI functional.

**Files to modify:** `src/index.ts`

**Steps:**

1. Import `runAgent` from `./agent.ts` (alias to `runAgentLoop` to avoid name collision with the local function).

2. Import all 7 tool handlers:
   ```ts
   import { shellHandler } from "./tools/shell.ts"
   import { readHandler } from "./tools/read.ts"
   import { writeHandler } from "./tools/write.ts"
   import { editHandler } from "./tools/edit.ts"
   import { grepHandler } from "./tools/grep.ts"
   import { globHandler } from "./tools/glob.ts"
   import { webfetchHandler } from "./tools/webfetch.ts"
   ```

3. Import `buildProviderLayer` from `./provider.ts`.

4. Create a `createHandlers()` function that returns `Record<string, (params: unknown) => Effect.Effect<string>>`. Each handler is wrapped with `Effect.provide(BunServices.layer)` and receives a `mockContext` (`{ preliminary: () => Effect.void }`):
   ```ts
   const mockContext = { preliminary: () => Effect.void }

   const createHandlers = (): Record<string, (params: unknown) => Effect.Effect<string>> => ({
     shell: (p) => shellHandler(p as Parameters<typeof shellHandler>[0], mockContext).pipe(Effect.provide(BunServices.layer)),
     read: (p) => readHandler(p as Parameters<typeof readHandler>[0], mockContext).pipe(Effect.provide(BunServices.layer)),
     write: (p) => writeHandler(p as Parameters<typeof writeHandler>[0], mockContext).pipe(Effect.provide(BunServices.layer)),
     edit: (p) => editHandler(p as Parameters<typeof editHandler>[0], mockContext).pipe(Effect.provide(BunServices.layer)),
     grep: (p) => grepHandler(p as Parameters<typeof grepHandler>[0], mockContext).pipe(Effect.provide(BunServices.layer)),
     glob: (p) => globHandler(p as Parameters<typeof globHandler>[0], mockContext).pipe(Effect.provide(BunServices.layer)),
     webfetch: (p) => webfetchHandler(p as Parameters<typeof webfetchHandler>[0], mockContext).pipe(Effect.provide(BunServices.layer)),
   })
   ```

5. Replace the local `runAgent` function. The new implementation:
   - Loads `AppConfig` and `SessionRepo`
   - Creates or loads session based on `--session` flag
   - Builds `AgentConfig` from config, session, and handlers
   - Builds provider layer via `buildProviderLayer(config.provider)`, providing `HttpClient` from `BunServices.layer`
   - Calls `runAgentLoop(promptText, agentConfig, providerLayer)`
   - Iterates over result `OutputEvent[]`, calling the formatter for each event
   - Saves session after agent completes
   - On error: logs to stderr, in `--print` mode exits with code 1

6. Add `AiError` import and handle agent errors with `Effect.catchAll`.

7. The `mainCommand` handler currently provides `AppConfig.layer` + `SessionRepo.layer`. After wiring, it also needs to provide the provider layer and handler context. Structure:
   ```ts
   const fullLayer = loadConfig(config)
     .pipe(Layer.merge(SessionRepo.layer))
     .pipe(Layer.merge(BunServices.layer))
   ```

8. Export `createHandlers` for testing purposes so integration tests can override individual handlers.

9. The provider layer from `buildProviderLayer(config.provider)` requires `HttpClient.HttpClient` which `BunServices.layer` provides. Compose by providing `BunServices.layer` to the provider layer:
   ```ts
   const providerLayer = buildProviderLayer(config.provider).pipe(
     Layer.provide(BunServices.layer)
   )
   ```

10. Verify existing unit tests still pass. No new tests in this task.

**Key concern:** Handler effects have different error types. `shellHandler`, `readHandler`, etc. return `Effect<string, AiError, ...>`. After `Effect.provide(BunServices.layer)`, they become `Effect<string, AiError, never>`. The `AgentConfig.handlers` type is `Record<string, (params: unknown) => Effect.Effect<string>>` which is `Effect<string, never, never>` — we need to `.pipe(Effect.mapError(() => "handler error"))` or similar to erase the `AiError` channel, or use `Effect.catchAll`. Alternatively, update `AgentConfig.handlers` type to `Effect.Effect<string, AiError>` to match. **Decision:** Update `AgentConfig.handlers` type in `agent.ts` to allow `AiError` in the error channel, since tool handlers can fail. Change to `(params: unknown) => Effect.Effect<string, AiError.AiError>`. This keeps the type honest.

**Verification:** `bun vitest run` passes. CLI can be invoked (`bun run src/index.ts --help` prints help). The typecheck passes.

---

### Task 2: Create test helpers and basic agent integration tests

Create the integration test helpers module and the first set of agent integration tests that exercise core happy-path scenarios.

**Files to create:**
- `src/__integration__/helpers.ts`
- `src/__integration__/agent-integration.test.ts` (basic scenarios: tests 1-5)

**Steps:**

1. Create `src/__integration__/helpers.ts` with:

   **Type definitions:**
   ```ts
   type MockPart =
     | { type: "text-delta"; delta: string }
     | { type: "tool-call"; id: string; name: string; params: unknown }
     | { type: "finish"; reason: string }
   type TurnResponse = MockPart[]
   ```

   **`createMockLLMLayer(responses: TurnResponse[]): Layer.Layer<LanguageModel.LanguageModel>`**
   - Uses `Ref` to track current turn index
   - `LanguageModel.make()` implementation:
     - `streamText`: Takes the current turn index from `Ref`, increments it, returns `Stream.fromIterable(responses[turnIndex])` mapped to `Response.StreamPartEncoded`-shaped objects. Each mock part is converted to the correct encoded shape:
       - `text-delta` → `{ type: "text-delta", id: "mock-id", delta, "~effect/ai/Content/Part": "~effect/ai/Content/Part", metadata: {} }`
       - `tool-call` → `{ type: "tool-call", id, name, params, providerExecuted: false, "~effect/ai/Content/Part": "~effect/ai/Content/Part", metadata: {} }`
       - `finish` → `{ type: "finish", reason, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, "~effect/ai/Content/Part": "~effect/ai/Content/Part", metadata: {} }`
     - `generateText`: Returns `Effect.succeed([])`
   - Returns `Layer.effect(LanguageModel.LanguageModel, service)` where `service` is the `LanguageModel.make()` result

   **`createStubHandlers(overrides?: Record<string, string | Error>): { handlers: Record<string, (params: unknown) => Effect.Effect<string>>, calls: Record<string, unknown[]> }`**
   - Creates handlers for all 7 tools (shell, read, write, edit, grep, glob, webfetch)
   - Each handler pushes its params to `calls[toolName]` array
   - Default return: `"stub <toolName> result"` string
   - If `overrides[toolName]` is a string, return that string
   - If `overrides[toolName]` is an `Error`, return `Effect.fail(AiError.make({...}))`
   - All handlers are `Effect<string, AiError.AiError, never>` (no service requirements)

   **`createTestConfig(overrides?: Partial<ConfigData>): ConfigData`**
   - Returns a default `ConfigData` with sensible test values:
     ```ts
     {
       provider: { type: "openai-compat", apiKey: "test-key", baseUrl: "http://localhost:0", model: "test-model" },
       approvalMode: "none",
       maxTurns: 10,
       systemPrompt: undefined,
     }
     ```
   - Spreads `overrides` on top

   **`createTestSession(messages?: Message[]): Session`**
   - Returns a `Session` with a UUID, given messages (default empty), and current timestamps

2. Create `src/__integration__/agent-integration.test.ts` with these tests using `@effect/vitest`:

   **Test 1: Text-only response**
   - Mock LLM: `[text-delta("Hello, world!"), finish("stop")]`
   - Config: `approvalMode: "none"`, `maxTurns: 10`
   - Session: empty
   - Assert: Output events include exactly `[text-delta, finish]` (types). No tool-call or tool-result events.

   **Test 2: Single tool call then finish**
   - Mock LLM: turn 1 = `[tool-call("read", { filePath: "/test.txt" })]`, turn 2 = `[text-delta("Done"), finish("stop")]`
   - Stub handlers: read returns `"file contents here"`
   - Assert: Output includes tool-call for "read", tool-result with `result="file contents here"` and `isError=false`, then text-delta and finish events.

   **Test 3: Two tool calls in one turn**
   - Mock LLM: turn 1 = `[tool-call("read", { filePath: "/a" }), tool-call("write", { filePath: "/b", content: "x" })]`, turn 2 = `[finish("stop")]`
   - Stub handlers: read returns `"read result"`, write returns `"write result"`
   - Assert: Output has 2 tool-call and 2 tool-result events. `calls.read` contains `{ filePath: "/a" }`, `calls.write` contains `{ filePath: "/b", content: "x" }`.

   **Test 4: Unknown tool**
   - Mock LLM: turn 1 = `[tool-call("nonexistent", { foo: "bar" })]`, turn 2 = `[finish("stop")]`
   - Assert: Tool-result event has `isError=true` and `result` contains "Unknown tool: nonexistent".

   **Test 5: Tool execution error**
   - Stub handlers: `read` overridden with `new Error("file not found")`
   - Mock LLM: turn 1 = `[tool-call("read", { filePath: "/bad" })]`, turn 2 = `[finish("stop")]`
   - Override just the read handler in `createStubHandlers({ read: new Error("file not found") })`
   - Assert: Tool-result event has `isError=true`.

   Each test runs `runAgent` from `agent.ts` directly with the mock LLM layer provided via `Effect.provide`. Use `Effect.provide(testLayer)` where `testLayer` merges `mockLLMLayer`.

**Verification:** `bun vitest run --project integration` passes all 5 new tests. `bun vitest run` (all projects) also passes.

---

### Task 3: Add agent integration tests for policy scenarios

Add the remaining agent integration tests covering approval modes, max turns, system prompts, and session accumulation.

**Files to modify:** `src/__integration__/agent-integration.test.ts` (add 5 more test cases)

**Steps:**

1. **Test 6: approvalMode "none"**
   - Config: `approvalMode: "none"`
   - Mock LLM: `[tool-call("shell", { command: "rm -rf /" }), finish("stop")]` (turn 1), `[finish("stop")]` (turn 2)
   - Assert: No `tool-approval-request` events in output.

   **Test 7: approvalMode "dangerous"**
   - Config: `approvalMode: "dangerous"`
   - Mock LLM: `[tool-call("shell", { command: "ls" }), tool-call("read", { filePath: "/test.txt" })]` (turn 1), `[finish("stop")]` (turn 2)
   - Assert: `tool-approval-request` events present for "shell" but NOT for "read".

   **Test 8: maxTurns 1 with tool call**
   - Config: `maxTurns: 1`
   - Mock LLM: `[tool-call("read", { filePath: "/test.txt" })]` (no finish)
   - Stub: read returns `"result"`
   - Assert: Last output event is `{ type: "error", message: "Max turns exceeded" }`.

   **Test 9: System prompt prepended**
   - Empty session + `systemPrompt: "You are a helpful assistant."`
   - Mock LLM: `[text-delta("Hi"), finish("stop")]`
   - Custom mock that captures `prompt` argument to verify it includes a system message.
   - To verify: extend `createMockLLMLayer` to accept an `onCall` callback that receives the prompt messages, or use a `Ref` to capture the prompt passed to `streamText`.

   **Test 10: Session messages accumulate**
   - Mock LLM: turn 1 = `[tool-call("read", { filePath: "/test.txt" })]`, turn 2 = `[text-delta("Done"), finish("stop")]`
   - After `runAgent` completes, inspect `agentConfig.session.messages`.
   - Assert: messages include the original user message, and tool result messages are present.

2. For test 9, add an optional `onStreamTextCall?: (prompt: Prompt.MessageEncoded[]) => void` callback to `createMockLLMLayer`. The `streamText` implementation calls this callback with the prompt before returning the stream. This allows tests to inspect what messages were sent to the LLM.

**Verification:** All 10 agent integration tests pass. Unit tests still pass.

---

### Task 4: Add output integration tests

Create tests that exercise the output formatters through the agent pipeline.

**Files to create:** `src/__integration__/output-integration.test.ts`

**Steps:**

1. **Test: Stream-json formatter through agent**
   - Run `runAgent` with mock LLM returning `[text-delta("Hello"), finish("stop")]`
   - Create `makeStreamJsonFormatter()`, collect output by intercepting `Console.log`
   - For each `OutputEvent` in the result, call the formatter
   - Assert: Each line of captured output is valid JSON. First line has `type: "content"`, last line has `type: "final"`.

2. **Test: Text formatter through agent**
   - Run `runAgent` with same mock LLM
   - Create `makeTextFormatter()`, collect output
   - Assert: Output contains "Hello" text, finish message.

3. **Test: All event types produce valid output**
   - Create each `OutputEvent` type manually (text-delta, tool-call, tool-result, tool-approval-request, approval-response, finish, error)
   - Feed through `makeStreamJsonFormatter()`
   - Assert: No errors thrown, each produces a single JSON line
   - Feed through `makeTextFormatter()`
   - Assert: No errors thrown

   For intercepting `Console.log`, use `Effect.gen(function* () { ... })` with a test layer providing a custom `Console` service, or use a simple approach: collect output into an array by providing `Layer.succeed(Console.Console, { log: (msg) => Effect.sync(() => outputs.push(msg)) })`.

**Verification:** All 3 output integration tests pass. Unit tests still pass.

---

### Task 5: Add E2E tests with mock OpenAI-compatible HTTP server

Create full end-to-end tests that exercise the CLI → provider → agent → tools → output pipeline using a real `@effect/ai-openai-compat` provider pointing at a mock HTTP server.

**Files to create:** `src/__integration__/e2e.test.ts`

**Steps:**

1. **Add `createMockOpenAIServer` to `helpers.ts`:**

   ```ts
   createMockOpenAIServer(options: {
     responses: MockOpenAIResponse[]
     port?: number
   }): Effect.Effect<{ url: string, calls: MockOpenAIRequest[], cleanup: () => void }>
   ```

   Where `MockOpenAIResponse` is:
   ```ts
   type MockOpenAIResponse =
     | { type: "text"; content: string }
     | { type: "tool-call"; id: string; name: string; arguments: Record<string, unknown> }
   ```

   The server:
   - Listens on a random available port
   - Handles `POST /chat/completions` with SSE streaming
   - On each request, pops the next response array from the queue
   - For "text" type: sends SSE chunks with `delta: { content: "..." }`
   - For "tool-call" type: sends SSE chunk with `delta: { tool_calls: [...] }`
   - Finishes each response with a `finish_reason: "stop"` or `"tool-calls"` chunk + `data: [DONE]`
   - Records all incoming requests (body JSON) in `calls` array
   - Returns `{ url: "http://localhost:PORT/v1", calls, cleanup }`
   - `cleanup()` shuts down the server

2. **E2E Test 1: Full pipeline with text response**
   - Start mock OpenAI server returning a text response
   - Build `ConfigData` with `baseUrl: mockUrl`, `apiKey: "test-key"`
   - Build provider layer via `buildProviderLayer(config.provider).pipe(Layer.provide(BunServices.layer))`
   - Build handlers via `createStubHandlers()`
   - Create session, build `AgentConfig`
   - Call `runAgent` with the real provider layer
   - Assert: Output events include text-delta and finish

3. **E2E Test 2: Tool call through real provider**
   - Mock server: turn 1 returns tool-call for "read" with `filePath`, turn 2 returns text
   - Stub read handler returns content
   - Run agent with real provider layer
   - Assert: Output includes tool-call, tool-result (`isError=false`), text-delta, finish

4. **E2E Test 3: Session creates and saves**
   - Use `SessionRepo` with real file system (temp directory)
   - Mock server returns text response
   - Run agent, then load session from `SessionRepo`
   - Assert: Session file exists with user message

5. **E2E Test 4: CLI handler E2E — session list**
   - Test the `session list` subcommand directly
   - Create a session file manually, then run `SessionRepo.list()`
   - Assert: Session appears in listing

6. **E2E Test 5: CLI handler E2E — config show**
   - Test the `config show` subcommand
   - Set env vars for API key, run with `AppConfig` layer
   - Assert: Output is JSON with API key masked as `***`

   For tests 4-5, invoke the CLI handler logic directly (import and call the handler function from `index.ts`) rather than spawning a subprocess.

**Verification:** All E2E tests pass. All unit and integration tests still pass. `bun vitest run` succeeds across all projects.

---

## Testing Plan

### Unit Tests (existing, unchanged)
- Config, session, output, approval, provider, tools (shell, read, write, edit, grep, glob, webfetch)
- These continue to pass unchanged

### Integration Tests (new)

**Agent integration (`agent-integration.test.ts`):**
1. Text-only response → finish event, no tool calls
2. Single tool call then text → tool-call, tool-result, text-delta, finish
3. Two tool calls in one turn → both handlers called
4. Unknown tool → error result
5. Tool execution error → isError=true
6. approvalMode "none" → no approval-request events
7. approvalMode "dangerous" → approval for shell, not for read
8. maxTurns 1 → error "Max turns exceeded"
9. System prompt prepended → messages start with system message
10. Session messages accumulate → user + tool result messages present

**Output integration (`output-integration.test.ts`):**
1. Stream-json through agent → valid LDJSON
2. Text through agent → expected text output
3. All event types → no errors in formatters

**E2E (`e2e.test.ts`):**
1. Full pipeline with text response via mock OpenAI server
2. Tool call through real provider
3. Session creates and saves
4. CLI session list
5. CLI config show

## Verification Checklist

Before signaling `TASK_COMPLETE`, verify:

- [ ] `bun vitest run` passes all tests (unit + integration projects)
- [ ] `bun run typecheck` passes with no errors
- [ ] `bun run lint` passes with no errors
- [ ] Agent integration test 1-10 all pass
- [ ] Output integration tests all pass
- [ ] E2E tests all pass
- [ ] CLI `--help` still works (`bun run src/index.ts --help`)
- [ ] Existing unit tests unaffected

## Rollback Plan

1. If `index.ts` wiring causes issues, revert to stub `runAgent` (keep the real wiring in a separate branch)
2. If integration test directory causes issues, remove `src/__integration__/` directory
3. If mock LLM layer doesn't work with `LanguageModel.make()`, fall back to `Layer.succeed(LanguageModel.LanguageModel, ...)` with manual service construction

## Future Considerations

- Streaming output tests (verify text-delta events arrive in order)
- Multi-provider E2E tests (anthropic, openrouter) with mock servers
- Concurrent request handling tests
- Session resume E2E test (create session, add messages, resume with `--session`)
- Coverage reporting for integration tests

## Spec Readiness Checklist

- [x] All requirements are clearly defined (no unanswered questions)
- [x] All tasks are actionable and appropriately sized (2-4 hours each)
- [x] **All tasks are atomic (each task leaves codebase in working state)**
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable
- [x] Rollback plan exists