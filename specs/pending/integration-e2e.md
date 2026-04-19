# Integration & E2E Test Plan

## Overview

Wire up the real `runAgent` in `index.ts` and create integration/E2E tests covering the full agent loop with mocked LLM and stubbed tool handlers.

## Files to Create

| # | File | Purpose |
|---|------|---------|
| 1 | `src/__integration__/helpers.ts` | Mock LLM, stub handlers, test fixtures, mock OpenAI server |
| 2 | `src/__integration__/agent-integration.test.ts` | Agent loop integration tests (mock LLM layer) |
| 3 | `src/__integration__/output-integration.test.ts` | Output formatter integration tests |
| 4 | `src/__integration__/e2e.test.ts` | Full E2E tests (mock OpenAI HTTP server + real provider layer) |

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `src/index.ts` | Replace stub `runAgent` with real agent loop wiring |

---

## 1. Wire Up `src/index.ts` — Real `runAgent`

Replace the stub `runAgent` with the real implementation:

- Import `runAgent` from `./agent.ts` (aliased to avoid collision)
- Import all 7 tool handlers from `src/tools/`
- Create handler adapter: wrap each handler with `BunServices.layer` so each call is self-contained
- Build provider layer via `buildProviderLayer(config.provider)`
- Build `AgentConfig` from `AppConfig`, session, and handlers
- Call `runAgent(prompt, agentConfig, providerLayer)`
- Pipe result array through the formatter function
- Save session after agent completes
- Handle errors: write to stderr, exit with code 1 in `--print` mode

Handler adapter pattern:
```ts
const mockContext = { preliminary: () => Effect.void }
const handlers: Record<string, (params: unknown) => Effect.Effect<string>> = {
  shell: (p) => shellHandler(p as { command: string }, mockContext).pipe(Effect.provide(BunServices.layer)),
  read: (p) => readHandler(p as { filePath: string }, mockContext).pipe(Effect.provide(BunServices.layer)),
  write: (p) => writeHandler(p as { filePath: string, content: string }, mockContext).pipe(Effect.provide(BunServices.layer)),
  edit: (p) => editHandler(p as { filePath: string, oldString: string, newString: string }, mockContext).pipe(Effect.provide(BunServices.layer)),
  grep: (p) => grepHandler(p as { pattern: string, path: string }, mockContext).pipe(Effect.provide(BunServices.layer)),
  glob: (p) => globHandler(p as { pattern: string, path: string }, mockContext).pipe(Effect.provide(BunServices.layer)),
  webfetch: (p) => webfetchHandler(p as { url: string }, mockContext).pipe(Effect.provide(BunServices.layer)),
}
```

---

## 2. `src/__integration__/helpers.ts`

### Mock LLM Layer Builder

```ts
createMockLLMLayer(responses: TurnResponse[]): Layer.Layer<LanguageModel.LanguageModel>
```

- `TurnResponse` = `Array<MockPart>` where `MockPart` is a union type
- Uses `LanguageModel.make()` with `streamText` returning `Stream.fromIterable(parts)` for the current turn
- Maintains a closure-scoped counter to serve sequential turns
- `generateText` returns `Effect.succeed([])`
- Supports: `text-delta`, `tool-call`, `finish`, `error` part types

### Stub Tool Handlers

```ts
createStubHandlers(overrides?: Partial<Record<string, string | Error>>): {
  handlers: Record<string, (params: unknown) => Effect.Effect<string>>
  calls: Record<string, unknown[]>
}
```

- Returns handler record where each handler records its call params
- Default: each tool returns a success string
- Overrides: specify return value (string for success) or Error instance for failure
- All handlers are `Effect<never>` (no service dependencies)

### Test Fixtures

```ts
createTestConfig(overrides?): ConfigData
createTestSession(messages?): Session
```

### Mock OpenAI-Compatible HTTP Server

```ts
createMockOpenAIServer(options: {
  responses: MockOpenAIResponse[]
  port?: number
}): Effect.Effect<{ server: Server, url: string, calls: MockOpenAIRequest[] }>
```

- Starts a Bun HTTP server on a random port
- Handles `POST /chat/completions` with SSE streaming
- Records all incoming requests for assertion
- Returns SSE events in OpenAI format: `data: {json}\n\n` followed by `data: [DONE]\n\n`
- Response format matches `@effect/ai-openai-compat` `ChatCompletionChunk` schema

---

## 3. `src/__integration__/agent-integration.test.ts`

| # | Test | Setup | Assertions |
|---|------|-------|------------|
| 1 | Text-only response | Mock LLM: `[text-delta("Hello"), finish("stop")]` | Output: `[text-delta, finish]`. No tool-call or tool-result events. |
| 2 | Single tool call then finish | Mock LLM: turn 1 = `[tool-call("read", {filePath: "/test.txt"})]`, turn 2 = `[text-delta("Done"), finish("stop")]` | Output: `[tool-call, tool-result, text-delta, finish]`. `result="file contents"`, `isError=false`. |
| 3 | Two tool calls in one turn | Mock LLM: turn 1 = `[tool-call("read", {filePath: "/a"}), tool-call("write", {filePath: "/b", content: "x"})]`, turn 2 = `[finish("stop")]` | Output has 2 tool-call + 2 tool-result events. Both handlers called. |
| 4 | Unknown tool | Mock LLM: turn 1 = `[tool-call("nonexistent", {})]`, turn 2 = `[finish("stop")]` | Tool-result with `isError=true`, `result` includes "Unknown tool". |
| 5 | Tool execution error | Stub: `read` handler returns `Effect.fail(...)`. Mock LLM: turn 1 = `[tool-call("read", ...)]`, turn 2 = `[finish("stop")]` | Tool-result with `isError=true`. |
| 6 | approvalMode: "none" | Config: `approvalMode: "none"`. Mock LLM: `[tool-call("shell", {command: "rm -rf /"}), finish("stop")]` | No `tool-approval-request` events. |
| 7 | approvalMode: "dangerous" | Config: `approvalMode: "dangerous"`. Mock LLM: `[tool-call("shell", ...), tool-call("read", ...)]` | `tool-approval-request` for "shell" but NOT for "read". |
| 8 | maxTurns: 1 with tool call | Config: `maxTurns: 1`. Mock LLM: `[tool-call("read", ...)]` (no finish in turn 1) | Output ends with `{ type: "error", message: "Max turns exceeded" }`. |
| 9 | System prompt prepended | Empty session + `systemPrompt: "You are helpful"`. Mock LLM: `[text-delta("Hi"), finish("stop")]` | Messages passed to mock LLM start with system message. |
| 10 | Session messages accumulate | Mock LLM: `[tool-call("read", {...})]`, turn 2 = `[finish("stop")]` | Session messages include user message + tool results. |

---

## 4. `src/__integration__/output-integration.test.ts`

| # | Test | Setup | Assertions |
|---|------|-------|------------|
| 1 | Stream-json through agent | Run agent with stream-json formatter. Collect `Console.log` output. | Parse each line as JSON. Verify event structure. |
| 2 | Text through agent | Run agent with text formatter. Collect output. | Output contains text content. Tool calls prefixed with `>`. |
| 3 | All event types valid | Feed each `OutputEvent` type directly to both formatters. | No errors thrown. Output is parseable/contains expected text. |

---

## 5. `src/__integration__/e2e.test.ts`

Full E2E tests using a **mock OpenAI-compatible HTTP server**.

| # | Test | Setup | Assertions |
|---|------|-------|------------|
| 1 | Full pipeline E2E | Start mock OpenAI server. Configure provider with `baseUrl: mockUrl`. Run CLI handler with `--prompt "hello" --output-format stream-json`. | Output contains text-delta and finish events as LDJSON. |
| 2 | Tool call E2E | Mock server returns tool call (`read`). Stub `read` handler. Mock server then returns text. | Tool call dispatched. Output has tool-call, tool-result, finish. |
| 3 | Session creates and saves | Run CLI with `--prompt "hello"`. | `.prodigy-coder/sessions/` has new session file with messages. |
| 4 | `--max-turns 1` E2E | Mock server returns tool call (no finish). Run CLI with `--max-turns 1`. | Output contains error event about max turns. |
| 5 | `session list` E2E | Create session files manually. Run CLI `session list`. | Output lists session IDs and timestamps. |
| 6 | `config show` E2E | Run CLI `config show` with env vars set. | Output is JSON with API keys masked as `***`. |

---

## Mock OpenAI Server Details

Handles `POST /chat/completions` and returns SSE responses matching `@effect/ai-openai-compat` format.

**Response format** (SSE stream):
```
data: {"id":"chatcmpl-test","model":"gpt-4o","created":1234567890,"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-test","model":"gpt-4o","created":1234567890,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}

data: [DONE]
```

**Tool call response**:
```
data: {"id":"chatcmpl-test","model":"gpt-4o","created":1234567890,"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\"filePath\":\"/test.txt\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-test","model":"gpt-4o","created":1234567890,"choices":[{"index":0,"delta":{},"finish_reason":"tool-calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}

data: [DONE]
```

---

## Execution Order

1. Wire up `index.ts` first (enables E2E tests)
2. Create `helpers.ts`
3. Create `agent-integration.test.ts`
4. Create `output-integration.test.ts`
5. Create `e2e.test.ts`
6. Run all tests, fix any issues
7. Run `bun vitest run` to verify all tests pass
