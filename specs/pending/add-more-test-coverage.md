# Add More Test Coverage

## Overview

Increase test coverage across the codebase with a focus on integration and E2E tests. Unit tests should only be added for edge cases and branches that are difficult to reach through higher-level tests.

## Background

The project currently has 77 passing tests across 16 test files. Core modules like `output`, `approval`, `config`, `session`, `provider`, and individual tools have unit tests. Integration tests exist for the agent loop and output formatters, plus a basic E2E test. However, several important paths remain untested:

- **CLI commands** (`src/index.ts`) have no tests at all
- **Bedrock provider** path in `src/provider.ts` is untested
- **Bedrock config** logic (region-based base URL) is untested
- **Agent loop** branches for array/object `encodedResult` and `approvalMode: "all"` are untested
- **Session repo** behavior with corrupted files is untested
- **Mock OpenAI HTTP server** helper exists but is unused in any E2E test
- Several tools have untested empty-output edge cases

## Requirements

- [x] CLI integration tests for `session list`, `session delete`, `config show`, and main command
- [x] Agent integration tests for `approvalMode: "all"`, maxTurns with text-only, multi-turn flows
- [ ] E2E test using the mock OpenAI HTTP server
- [ ] Unit tests for bedrock provider and config paths
- [ ] Unit tests for session repo edge cases (corrupted files, invalid JSON)
- [ ] Unit tests for tool empty-output edge cases

## Tasks

- [x] **Task 1**: Export CLI command effects from `src/index.ts` and add CLI integration tests
- [x] **Task 2**: Extend `MockPart` in integration helpers and add agent integration edge-case tests
- [ ] **Task 3**: Add E2E test using mock OpenAI HTTP server
- [ ] **Task 4**: Add bedrock provider and config unit tests
- [ ] **Task 5**: Add session and tool edge-case unit tests

## Implementation Details

### Task 1: Export CLI commands and add CLI integration tests

**Goal**: Test CLI command handlers for `session list`, `session delete`, `config show`, and the main command's no-prompt handling.

**Changes to `src/index.ts`**:
1. Export `mainCommand`, `listSessionsCommand`, `deleteSessionCommand`, `configShowCommand` (add `export` keyword to each const)
2. No other logic changes

**New file: `src/__integration__/cli-integration.test.ts`**:
1. Import the exported commands from `../index.ts`
2. Import `Command` from `effect/unstable/cli`
3. Import `TestConsole` from `effect/testing/TestConsole`
4. Import `SessionRepo`, `AppConfig`, `loadConfig`, `maskConfig`
5. Import `bunServicesLayer`
6. Use `Command.runWith(command, { version: "0.0.1" })` to execute each command with args
7. Provide necessary layers (`SessionRepo.layer`, `AppConfig.layer`, `TestConsole.layer`, `bunServicesLayer`)

**Test cases to add**:
- `session list` with no sessions → console output includes `"No sessions found"`
- `session list` with sessions → console output includes session IDs and timestamps
- `session delete <id>` → console output includes `"Deleted session"`
- `config show` → console output includes masked config JSON with `"***"` for API key
- Main command with no prompt → console output includes `"No prompt provided"`

**Important**: For `config show` and main command tests, provide `AppConfig` via `loadConfig()` with a test config layer. Use `TestConsole` to capture output.

### Task 2: Extend mock helpers and add agent integration edge-case tests

**Goal**: Cover `approvalMode: "all"`, maxTurns with text-only, multi-turn text→tool→finish, and tool-result encoding branches.

**Changes to `src/__integration__/helpers.ts`**:
1. Extend `MockPart` union with:
   ```ts
   | { type: "tool-result"; id: string; name: string; encodedResult: unknown; isFailure?: boolean; preliminary?: boolean }
   ```
2. Extend `mockPartToEncoded` with a `case "tool-result"` that returns:
   ```ts
   {
     type: "tool-result",
     id: part.id,
     name: part.name,
     encodedResult: part.encodedResult,
     isFailure: part.isFailure ?? false,
     preliminary: part.preliminary ?? false
   }
   ```

**Additions to `src/__integration__/agent-integration.test.ts`**:
1. **approvalMode "all"**: Mock LLM calls `read` and `shell`. Verify both produce `tool-approval-request` events.
2. **maxTurns text-only**: Mock LLM returns text-delta without finish. With `maxTurns: 2`, verify agent stops after 2 turns and outputs an error event.
3. **Multi-turn text then tool**: First turn returns text-delta, second turn returns tool-call, third returns finish. Verify all event types appear in correct order.
4. **Tool result with array encodedResult**: Mock LLM calls `grep` (stub toolkit returns `string[]`). Verify `tool-result` event `result` is a newline-joined string of the array.
5. **Tool result with object encodedResult**: Mock LLM produces `tool-result` directly with `encodedResult: { foo: "bar" }`. Verify `tool-result` event `result` is `JSON.stringify` of the object.
6. **Preliminary tool result is ignored**: Mock LLM produces `tool-result` with `preliminary: true`. Verify no `tool-result` output event is generated.

**Note on Test 5 (object encodedResult)**: Effect v4 AI module schema validation requires `tool-result` `name` to match toolkit literals and `result` to match the tool's success schema. No tool in the toolkit has an object success schema, so this test is marked as `it.todo` — the agent code does handle object `encodedResult` via `JSON.stringify` (verified by reading `src/agent.ts`), but it cannot be exercised through the mock LLM due to framework-level schema constraints.

### Task 3: Add E2E test using mock OpenAI HTTP server

**Goal**: Test the full stack from HTTP request through provider layer to agent loop.

**New file: `src/__integration__/provider-e2e.test.ts`**:
1. Import `createMockOpenAIServer` from `./helpers.ts`
2. Import `runAgent` from `../agent.ts`
3. Import `buildProviderLayer` from `../provider.ts`
4. Import `createTestConfig`, `createTestSession` from `./helpers.ts`
5. Import `MyToolkitLayer` from `../tools/index.ts`
6. Import `Layer`, `Effect`, `FetchHttpClient` from `effect`

**Test flow**:
1. Start mock OpenAI server with a single text response: `[{ type: "text", content: "Hello from server" }]`
2. Create config with `type: "openai-compat"`, `baseUrl: server.url`, `apiKey: "test"`
3. Build provider layer with `buildProviderLayer(config.provider)`
4. Merge with `MyToolkitLayer` and `FetchHttpClient.layer`
5. Run agent with prompt `"test"`
6. Verify output events contain `text-delta` with `"Hello from server"` and a `finish` event
7. Stop mock server in `Effect.ensuring`

**Additional test**:
1. Start mock server with a tool-call response: `[{ type: "tool-call", id: "call-1", name: "read", arguments: { filePath: "/tmp/test.txt" } }]`
2. Run agent with `approvalMode: "none"`
3. Verify output events contain `tool-call` and `tool-result` events

### Task 4: Add bedrock provider and config unit tests

**Additions to `src/provider.test.ts`**:
1. Test `buildProviderLayer` for `bedrock` type with explicit `model` and `region`:
   ```ts
   const config = { type: "bedrock" as const, apiKey: "test-key", model: "custom-model", region: "us-west-2" };
   const layer = buildProviderLayer(config);
   expect(layer).toBeDefined();
   ```
2. Test `buildProviderLayer` for `bedrock` type with defaults (no model, no region):
   ```ts
   const config = { type: "bedrock" as const, apiKey: "test-key" };
   const layer = buildProviderLayer(config);
   expect(layer).toBeDefined();
   ```

**Additions to `src/config.test.ts`**:
1. Test bedrock region env var sets base URL correctly:
   - Write config with `type: "bedrock"`, no `baseUrl`
   - Provide env `BEDROCK_REGION: "eu-west-1"`
   - Verify loaded config `provider.baseUrl` is `https://bedrock-mantle.eu-west-1.api.aws/v1`
2. Test bedrock with explicit baseUrl overrides region default:
   - Write config with `type: "bedrock"`, `baseUrl: "https://custom.aws/v1"`
   - Provide env `BEDROCK_REGION: "eu-west-1"`
   - Verify loaded config `provider.baseUrl` is `https://custom.aws/v1`

### Task 5: Add session and tool edge-case unit tests

**Additions to `src/session.test.ts`**:
1. Test `loadSession` with invalid JSON → should fail with a parse error (use `Effect.flip` and verify error is defined)
2. Test `listSessions` skips corrupted files and returns valid ones:
   - Create session1, save it
   - Write a corrupted `.json` file directly to `.prodigy-coder/sessions`
   - Create session2, save it
   - Call `repo.list()`
   - Verify list contains both valid session IDs and no corrupted entries

**Additions to `src/tools/shell.test.ts`**:
1. Test empty stdout command returns empty string (not error):
   ```ts
   const result = yield* shellHandler({ command: "true" }, mockContext);
   expect(result).toBe("");
   ```

**Additions to `src/tools/glob.test.ts`**:
1. Test empty results for directory with no matching files:
   ```ts
   const result = yield* globHandler({ pattern: "*.nonexistent", path: "/tmp" }, mockContext);
   expect(result.length).toBe(0);
   ```

## Testing Plan

### Integration Tests
- CLI commands produce correct console output
- Agent handles `approvalMode: "all"` correctly
- Agent respects `maxTurns` with text-only responses
- Multi-turn text→tool→finish flow produces correct events
- Array and object `encodedResult` are formatted correctly
- Preliminary tool results are ignored
- Mock OpenAI server E2E: text response and tool-call response

### Unit Tests
- Bedrock provider layer builds successfully with and without explicit model/region
- Bedrock config base URL is derived from region env var
- Bedrock explicit baseUrl overrides region default
- Session load fails gracefully on invalid JSON
- Session list skips corrupted files
- Shell tool returns empty string for no-output commands
- Glob tool returns empty array for no matches

## Verification Checklist

Before signaling `TASK_COMPLETE`, verify:
- [x] All new tests pass
- [x] Existing tests still pass (no regressions)
- [x] `src/index.ts` exports do not break the CLI binary (`bun run src/index.ts --help` works)
- [ ] Mock OpenAI server test exercises real HTTP stack
- [x] No `any` types introduced in test files

## Rollback Plan

1. Revert test file additions individually
2. Remove exports from `src/index.ts` if they cause issues
3. Revert helper changes in `src/__integration__/helpers.ts`

## Future Considerations (Optional)

- Add E2E test for session resume (`--session` flag) through CLI
- Add integration test for `write` tool creating nested directories
- Add property-based tests for output formatters

## Spec Readiness Checklist

Before running ralph-loop.sh, verify:
- [x] All requirements are clearly defined (no unanswered questions)
- [x] All tasks are actionable and appropriately sized (1-4 hours each)
- [x] **All tasks are atomic (each task leaves codebase in working state)**
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable
- [x] Rollback plan exists
