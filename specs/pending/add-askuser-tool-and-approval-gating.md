# Add AskUserTool and Real Tool Approval Flow

## Overview

Implement two related features:
1. **`AskUserTool`** — a new tool that lets the LLM ask the user clarifying questions mid-conversation, using Effect's native `Prompt.text`.
2. **Real tool approval gating** — make the existing approval system actually block tool execution (instead of just emitting informational events). Uses Effect's `Prompt.confirm` for interactive Yes/No prompts, with a `--non-interactive` CLI flag and TTY detection.

## Background

The current approval system in `agent.ts` emits `tool-approval-request` events into the output stream, but the Effect AI framework auto-executes tool handlers eagerly via `LanguageModel.streamText({ toolkit: MyToolkit })`. By the time the user sees the approval prompt, the dangerous tool has already run.

To fix this, we gate execution inside the dangerous tool handlers themselves. When approval is needed, the handler calls `Prompt.confirm` and either proceeds or returns an `AiError` (which the framework converts to a `tool-result` with `isError: true`, fed back to the LLM on the next turn).

`AskUserTool` follows the same pattern — it uses `Prompt.text` for free-form user questions, and fails gracefully in non-interactive mode.

## Requirements

- [ ] `ask_user` tool is available to the LLM for asking free-text questions
- [ ] Tool approval actually blocks execution (not just emits events)
- [ ] Approval prompt shows tool name **and** its parameters
- [ ] Denied tools return an error to the LLM so it can try something else
- [ ] `--non-interactive` / `-n` CLI flag disables all interactive prompts (approvals denied, AskUserTool errors)
- [ ] When stdin is not a TTY and `--non-interactive` is not explicitly set, approvals default to denied and AskUserTool errors
- [ ] Existing `approval-mode` config still works (`none`, `dangerous`, `all`)
- [ ] All existing tests pass; new tests cover approval granted, approval denied, and AskUserTool behavior

## Tasks

- [x] **Task 1**: Create AskUserTool, non-interactive config, ApprovalGate service, and register in toolkit
- [ ] **Task 2**: Integrate approval gating into handlers, agent, output, CLI, and update all tests

## Implementation Details

### Task 1: Create AskUserTool, non-interactive config, ApprovalGate service, and register in toolkit

**Goal**: Add all new code and config without changing existing behavior. This task leaves the codebase compilable and all existing tests passing.

#### 1.1 Create `src/approval-gate.ts`

Create the `ApprovalGate` Effect service:

```ts
class ApprovalGate extends Context.Service<ApprovalGate, {
  readonly approve: (toolName: string, params: unknown) => Effect.Effect<boolean>
}>()("ApprovalGate") {}
```

Implement `makeApprovalGateLayer(config: ConfigData)`:
- If `approvalMode === "none"` → auto-approve
- If tool is not in `DANGEROUS_TOOLS` and mode is `"dangerous"` → auto-approve
- If `config.nonInteractive === true` → auto-deny
- If `process.stdin.isTTY` is falsy → auto-deny
- Otherwise → `Prompt.run(Prompt.confirm({ message: \`Allow ${toolName}(${JSON.stringify(params)})?\`, initial: false }))`

Export `approvalDeniedError(toolName: string): AiError.AiError` for reuse in handler wrappers.

**Testing**: Create `src/approval-gate.test.ts` with unit tests for:
- `"none"` mode always approves
- `"dangerous"` mode approves non-dangerous tools, denies dangerous tools (mocked)
- `"all"` mode denies all tools (mocked)
- `nonInteractive: true` auto-denies
- TTY detection fallback (mock `process.stdin.isTTY`)

#### 1.2 Create `src/tools/askUser.ts`

Define `AskUserTool`:
- Parameters: `Schema.Struct({ question: Schema.String })`
- Description: `"Ask the user a free-text question and return their answer. Use this when you need clarification or additional information from the user."`
- Success: `Schema.String`

Implement `makeAskUserHandler(nonInteractive: boolean)` factory:
- If `nonInteractive === true` → fail with `AiError` "Cannot ask user questions in non-interactive mode"
- If `process.stdin.isTTY` is falsy → fail with `AiError` "Cannot ask user questions when stdin is not a TTY"
- Otherwise → `Prompt.run(Prompt.text({ message: question }))`

**Testing**: Create `src/tools/askUser.test.ts` with unit tests using a mock `Terminal` layer (follow the `MockTerminal` pattern from `effect-smol`). Test:
- Handler succeeds and returns user input when Terminal is available
- Handler fails with error in non-interactive mode

#### 1.3 Update `src/config.ts`

- Add `nonInteractive: Schema.optionalWith(Schema.Boolean, { default: () => false })` to `ConfigSchema`
- Update `defaultConfig` to include `nonInteractive: false`
- Add `parseBoolean` helper for env var parsing
- Update `envOverrides` signature to accept `nonInteractive: string | undefined` and merge it into the config
- Read `PRODIGY_CODER_NON_INTERACTIVE` env var in both `AppConfig.layer` and `AppConfig.layerWithPath`

**Testing**: Update `src/config.test.ts` (if it exists) to cover `nonInteractive` parsing from env vars and config file.

#### 1.4 Update `src/tools/index.ts`

- Import `AskUserTool` and `makeAskUserHandler` from `./askUser.ts`
- Add `AskUserTool` to `MyToolkit = Toolkit.make(...)`
- Add `ask_user: makeAskUserHandler(false)` to `MyToolkitLayer` (default `false` for backward-compatible test usage)
- Export `AskUserTool`

#### 1.5 Update `src/__integration__/helpers.ts`

In `createStubToolkit`, add `askUser` stub:
```ts
askUser: makeHandler("askUser", "stub ask result")
```

**Verification at end of Task 1**:
- `bun run typecheck` passes
- `bun run test` passes (no existing tests broken)
- New tests (`approval-gate.test.ts`, `askUser.test.ts`) pass

---

### Task 2: Integrate approval gating into handlers, agent, output, CLI, and update all tests

**Goal**: Wire the ApprovalGate into the live app, remove the old broken approval event system, and update all tests.

#### 2.1 Update `src/tools/index.ts` — add `makeToolkitLayer` factory

Export a new factory function:
```ts
export const makeToolkitLayer = (config: { approvalMode: ApprovalMode; nonInteractive: boolean }): Layer.Layer<Tool.HandlersFor<typeof MyToolkit.tools>> =>
  MyToolkit.toLayer({
    shell: withApproval("shell", config, shellHandler),
    read: readHandler,
    write: writeHandler,
    edit: editHandler,
    grep: grepHandler,
    glob: globHandler,
    webfetch: webfetchHandler,
    ask_user: makeAskUserHandler(config.nonInteractive)
  });
```

Implement `withApproval` helper:
- Use `Effect.serviceOption(ApprovalGate)` to optionally access the gate
- If `ApprovalGate` is present and `approve()` returns `false` → fail with `approvalDeniedError(toolName)`
- If `ApprovalGate` is not present → proceed with original handler (preserves test compatibility)
- If approved (or no gate) → `yield* originalHandler(params, context)`

**Important**: `withApproval` wraps the handler in an `Effect.gen` that yields the original handler. Since the original handler may itself fail (e.g., shell command fails), failures bubble up naturally.

Keep `MyToolkitLayer` exported as-is (raw handlers without approval wrappers) so existing tests using `createStubToolkit` continue to work without providing `ApprovalGate`.

#### 2.2 Update `src/agent.ts`

- Import `makeApprovalGateLayer` and `ApprovalGate` from `./approval-gate.ts`
- Remove the `tool-approval-request` event emission from the `tool-call` case (~lines 72-80)
- Remove or no-op the `tool-approval-request` stream part handler case (~lines 104-111)
- Construct `approvalGateLayer` from `config` inside the agent loop:
  ```ts
  const approvalGateLayer = makeApprovalGateLayer(config);
  const fullLayer = Layer.mergeAll(providerLayer, BunServices.layer, FetchHttpClient.layer, approvalGateLayer);
  ```
- Update `llmStream.pipe(...)` to use `Layer.mergeAll` instead of nested `Layer.merge`

#### 2.3 Update `src/index.ts`

- Add `--non-interactive` / `-n` boolean flag:
  ```ts
  const nonInteractiveFlag = Flag.boolean("non-interactive").pipe(
    Flag.withAlias("n"),
    Flag.withDescription("Run in non-interactive mode (deny all approvals, disable ask_user)"),
    Flag.withDefault(false)
  );
  ```
- Wire the flag into `mainCommand` args and pass it through to `runAgent` / config
- Change `providerLayer` construction to use `makeToolkitLayer(appConfig)` instead of raw `MyToolkitLayer`:
  ```ts
  const providerLayer = Layer.merge(buildProviderLayer(config.provider), makeToolkitLayer(appConfig)).pipe(
    Layer.provide(FetchHttpClient.layer)
  );
  ```

#### 2.4 Update `src/output.ts`

- Remove `ToolApprovalRequest` schema definition
- Remove `ApprovalResponse` schema definition
- Remove both from `OutputEvent` union
- Remove `tool-approval-request` case from `makeTextFormatter`
- Remove `approval-response` case from `makeTextFormatter`
- Remove `tool-approval-request` case from `makeStreamJsonFormatter`
- Remove `approval-response` case from `makeStreamJsonFormatter`

#### 2.5 Update `src/output.test.ts`

- Remove the test `"text formatter processes tool-approval-request event"`
- Remove the test `"text formatter processes approval-response event"`
- Remove the test `"stream-json formatter outputs valid LDJSON for approval-request"`
- Remove the test `"stream-json formatter outputs valid LDJSON for approval-response"`
- Update `"all event types are handled without errors"` test to remove `tool-approval-request` and `approval-response` events from the array

#### 2.6 Update `src/__integration__/output-integration.test.ts`

- Update `"Test 3: All event types produce valid output"` to remove `tool-approval-request` and `approval-response` from the `events` array

#### 2.7 Update `src/__integration__/agent-integration.test.ts`

Rewrite the approval-related tests to assert on real behavior:

**Test 6** (`approvalMode none`):
- Keep existing assertions but remove `approvalRequests` assertion
- Assert that `tool-result` exists and `isError: false`

**Test 7** (`approvalMode dangerous`):
- The test currently passes a stub toolkit layer with no `ApprovalGate`, so `withApproval` auto-approves (no gate = proceed)
- **Change**: Provide a mock `ApprovalGate` layer that returns `false` for all approvals
- Assert that `shell` tool-result has `isError: true` and result contains "denied approval"
- Assert that `read` tool-result has `isError: false` and returns normal stub result

**Test 11** (`approvalMode all`):
- Provide a mock `ApprovalGate` layer returning `false`
- Assert both `read` and `shell` tool-results have `isError: true`

**New test** — `approval granted`:
- Provide a mock `ApprovalGate` layer returning `true`
- Use `approvalMode: "dangerous"` with a `shell` tool call
- Assert `shell` tool-result has `isError: false`

**New test** — `askUserTool in non-interactive mode`:
- Mock LLM calls `ask_user` with `{ question: "What is your name?" }`
- Config has `nonInteractive: true`
- Assert tool-result has `isError: true` with message about non-interactive mode

#### 2.8 Update `src/approval.test.ts`

- No changes needed; `needsApproval()` logic is unchanged

#### 2.9 Update `src/agent.test.ts`

- Add `ask_user: () => Effect.succeed("")` to the mock toolkit layer in `agent.test.ts`
- No other changes needed (typecheck only)

**Verification at end of Task 2**:
- `bun run typecheck` passes
- `bun run test` passes
- Manual CLI test: `prodigy --approval-mode dangerous "list files"` should prompt for `shell` approval
- Manual CLI test: `prodigy --non-interactive --approval-mode dangerous "list files"` should deny `shell` without prompting
- Manual CLI test: `prodigy "ask me a question"` with a prompt that triggers `ask_user` should work interactively

## Testing Plan

### Unit Tests

- `approval-gate.test.ts`:
  - `makeApprovalGateLayer` with `"none"` mode always returns `true`
  - `"dangerous"` mode returns `false` for shell/write/edit, `true` for others
  - `"all"` mode returns `false` for all tools
  - `nonInteractive: true` bypasses prompt and returns `false`
  - Non-TTY stdin bypasses prompt and returns `false`

- `askUser.test.ts`:
  - Handler returns user input when Terminal is available
  - Handler fails with error when `nonInteractive` is `true`

### Integration Tests

- `agent-integration.test.ts`:
  - `approvalMode: "none"` executes dangerous tools without blocking
  - `approvalMode: "dangerous"` + mock gate denying → shell/write/edit fail with error, others succeed
  - `approvalMode: "dangerous"` + mock gate approving → all tools succeed
  - `approvalMode: "all"` + mock gate denying → all tools fail
  - `nonInteractive: true` + `ask_user` tool call → fails with error

### E2E / Manual Tests

- Run CLI with `--approval-mode dangerous` and verify interactive prompt appears for `shell`
- Run CLI with `--non-interactive --approval-mode dangerous` and verify no prompt, tool denied
- Run CLI with a prompt that triggers `ask_user` and verify interactive text prompt works

## Verification Checklist

Before signaling `TASK_COMPLETE`, verify:

- [ ] `bun run typecheck` passes with zero errors
- [ ] `bun run test` passes with zero failures
- [ ] Approval prompt displays tool name **and** parameters (e.g., `Allow shell({"command":"ls"})?`)
- [ ] Denied tools produce `tool-result` with `isError: true` and message "Tool X was denied approval"
- [ ] `--non-interactive` flag prevents all interactive prompts (both approval and ask_user)
- [ ] `ask_user` tool is listed in the toolkit and callable by the LLM
- [ ] No `tool-approval-request` or `approval-response` events are emitted from the agent
- [ ] Old `tool-approval-request` / `approval-response` formatter cases are removed

## Rollback Plan

1. Revert `src/tools/index.ts` to use `MyToolkitLayer` instead of `makeToolkitLayer`
2. Revert `src/agent.ts` to emit `tool-approval-request` events
3. Revert `src/output.ts` to include old event types
4. Remove `src/approval-gate.ts`, `src/tools/askUser.ts`, and their tests
5. Remove `--non-interactive` flag from `src/index.ts`
6. Remove `nonInteractive` from `src/config.ts`

## Future Considerations (Optional)

- Per-tool approval configuration (e.g., allow `write` but not `shell`)
- Timeout on interactive prompts
- AskUserTool with choice-based questions (single/multiple choice) using `Prompt.select` / `Prompt.multiSelect`
- Persist approval decisions per session ("remember my choice for this session")

## Spec Readiness Checklist

Before running ralph-loop.sh, verify:

- [x] All requirements are clearly defined (no unanswered questions)
- [x] All tasks are actionable and appropriately sized (1-4 hours each)
- [x] **All tasks are atomic (each task leaves codebase in working state)**
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable
- [x] Rollback plan exists
