# Prodigy Coder - AI Coding Agent CLI

## Overview

Build a command-line AI coding agent using Effect's AI and CLI modules (`effect/Unstable/Cli`) that can autonomously edit code, run shell commands, and search codebases. Compatible with ralph-loop system (ralph-auto.sh) via `--print` and `--output-format stream-json` flags. The CLI must use `@repos/effect-smol/packages/effect/src/unstable/cli/` (imported as `effect/Unstable/Cli`) for all CLI construction.

## Background

The ralph-auto.sh script currently uses `claude --dangerously-skip-permissions --verbose --model opus --print --output-format stream-json` as its agent. We need a self-hosted, Effect-based alternative that:
- Accepts prompts from stdin and outputs structured JSON (for ralph-loop)
- Supports tool calls (shell, read, write, edit, grep, glob, webfetch)
- Uses configurable AI providers (starting with OpenAI-compatible)
- Persists session history for multi-turn conversations
- Has configurable tool approval modes

## Requirements

- [x] CLI command with `--print` and `--output-format stream-json|text` flags
- [x] Config file (`.prodigy-coder.json`) with env var fallbacks
- [x] OpenAI-compatible provider with configurable base URL
- [x] Tools: shell, read, write, edit, grep, glob, webfetch
- [x] Session persistence in `.prodigy-coder/sessions/`
- [x] `--session`, `--model`, `--max-turns`, `--approval-mode` flags
- [x] Streaming output with text and stream-json formatters
- [x] Agent loop: prompt → LLM → tool calls → execute → repeat until done

## Tasks

- [x] **Task 1**: Project setup, config schema+loader, session persistence, output formatters, and base CLI (with vitest integration tests)
- [x] **Task 2**: AI provider layer construction with OpenAI-compat support (with vitest integration tests)
- [x] **Task 3**: Tool definitions and toolkit (all 7 tools with vitest integration tests)
- [x] **Task 4**: Agent loop with tool-call resolution, approval flow, and session auto-save (with vitest integration tests)
- [x] **Task 5**: Output formatters and final CLI wiring (with vitest integration tests)

## Implementation Details

### Task 1: Project setup, config, session, output, and base CLI

**Files to create:**
- `package.json` - add AI provider dependencies
- `src/config.ts` - Config schema and loader with env var fallbacks
- `src/session.ts` - Session schema and file-based persistence
- `src/output.ts` - Text and stream-json formatters
- `src/index.ts` - Effect CLI command with all flags
- `tests/config.test.ts` - Config loading tests
- `tests/session.test.ts` - Session persistence tests
- `tests/output.test.ts` - Output formatter tests

**Steps:**

1. Update `package.json` dependencies to add:
   - `@effect/ai-openai-compat`
   - `@effect/ai-openai`
   - `@effect/ai-anthropic`
   - `@effect/ai-openrouter`

2. Run `bun install` to install new dependencies.

3. Create `src/config.ts`:
   - Define config schemas using Effect Schema:
     ```ts
     import { Schema } from "effect"

     const ProviderType = Schema.Literal("openai-compat", "openai", "anthropic", "openrouter")
     const ApprovalMode = Schema.Literal("none", "dangerous", "all")

     const ProviderConfig = Schema.Struct({
       type: ProviderType,
       baseUrl: Schema.Optional(Schema.String),
       apiKey: Schema.Optional(Schema.String),
       model: Schema.String,
     })

     const Config = Schema.Struct({
       provider: ProviderConfig,
       approvalMode: ApprovalMode.withDefault("none"),
       maxTurns: Schema.Positive.withDefault(50),
       systemPrompt: Schema.Optional(Schema.String),
     })
     ```
   - `loadConfig(path?: string): Effect<Config>` - loads from file paths and env vars
   - Env vars checked: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `PRODIGY_CODER_API_KEY`, `PRODIGY_CODER_BASE_URL`, `PRODIGY_CODER_MODEL`, `PRODIGY_CODER_APPROVAL_MODE`
   - Use `Schema.decodeUnknown` to parse config files, `Schema.encodeUnknown` to serialize for `config show`

4. Create `src/session.ts`:
   - Define session schemas using Effect Schema:
     ```ts
     const Message = Schema.Struct({
       role: Schema.Literal("system", "user", "assistant"),
       content: Schema.String,
     })

     const Session = Schema.Struct({
       id: Schema.String,
       messages: Schema.Array(Message),
       createdAt: Schema.Date,
       updatedAt: Schema.Date,
     })
     ```
   - Extract inferred types using `Schema.infer` or `typeof Schema.Type<typeof Session>` pattern
   - Session directory: `.prodigy-coder/sessions/`
   - Functions:
     - `createSession(systemPrompt?: string): Effect<Session>` - creates new session with UUID
     - `saveSession(session: Session): Effect<void>` - writes to `.prodigy-coder/sessions/<id>.json` (serialize with `Schema.encodeUnknown`)
     - `loadSession(id: string): Effect<Session>` - reads from file (parse with `Schema.decodeUnknown`)
     - `listSessions(): Effect<ReadonlyArray<{id: string, createdAt: Date, updatedAt: Date}>>`
     - `deleteSession(id: string): Effect<void>`

5. Create `src/output.ts`:
   - Define output event schemas using Effect Schema:
     ```ts
     const TextDelta = Schema.Struct({ type: Schema.Literal("text-delta"), delta: Schema.String })
     const ToolCall = Schema.Struct({
       type: Schema.Literal("tool-call"),
       id: Schema.String,
       name: Schema.String,
       params: Schema.Unknown,
     })
     const ToolResult = Schema.Struct({
       type: Schema.Literal("tool-result"),
       id: Schema.String,
       name: Schema.String,
       result: Schema.String,
       isError: Schema.Boolean,
     })
     const ToolApprovalRequest = Schema.Struct({
       type: Schema.Literal("tool-approval-request"),
       id: Schema.String,
       toolCallId: Schema.String,
       toolName: Schema.String,
     })
     const ApprovalResponse = Schema.Struct({ type: Schema.Literal("approval-response"), approved: Schema.Boolean })
     const Finish = Schema.Struct({ type: Schema.Literal("finish"), text: Schema.String })
     const Error = Schema.Struct({ type: Schema.Literal("error"), message: Schema.String })

     const OutputEvent = Schema.Union(TextDelta, ToolCall, ToolResult, ToolApprovalRequest, ApprovalResponse, Finish, Error)
     ```
   - Text formatter: color-coded stdout output (blue for tool calls, red for errors)
   - Stream-json formatter: LDJSON (one JSON object per line, matches Claude Code format)
   - `createFormatter(format: "text" | "stream-json"): Formatter` - formatter interface has `format(event: OutputEvent): Effect<void>`

6. Create `src/index.ts` with Effect CLI command using `effect/Unstable/Cli`:
    - Import from `effect/Unstable/Cli` (not `@effect/cli`)
    - Main command `prodigy` with flags:
      - `--prompt <text>` (optional, can use stdin instead)
      - `--print` (non-interactive mode)
      - `--output-format text|stream-json` (default: text)
      - `--session <id>` (resume session)
      - `--model <name>` (override model)
      - `--max-turns <n>` (override max turns)
      - `--approval-mode none|dangerous|all` (override approval mode)
      - `--system-prompt <text>` (override system prompt)
      - `--config <path>` (config file path)
    - Subcommands:
      - `session list` - list sessions
      - `session delete <id>` - delete a session
      - `config show` - print current config (mask API keys)
    - Handler stub for now (full integration in later tasks):
      - Load config
      - Create/load session
      - Provide platform layers (FileSystem, Path, ChildProcessSpawner, HttpClient, IdGenerator, Terminal)
    - Default system prompt: `"You are a coding assistant. You have access to tools to read, write, edit files, run shell commands, search code, and fetch web content. Be concise and helpful."`

7. **Vitest integration tests for Task 1:**

   `tests/config.test.ts`:
   - `loadConfig` loads from `.prodigy-coder.json` file correctly
   - Env vars override file values (`PRODIGY_CODER_MODEL` overrides model in file)
   - Missing file returns default config
   - Invalid config file throws error
   - Provider type validation rejects invalid values

   `tests/session.test.ts`:
   - `createSession` returns session with valid UUID and empty messages
   - `saveSession` then `loadSession` returns equivalent session (roundtrip)
   - `listSessions` returns empty array when no sessions exist
   - `deleteSession` removes session file
   - Creating session with systemPrompt adds it as first message

   `tests/output.test.ts`:
   - Text formatter processes `text-delta` event (writes to mock stdout)
   - Text formatter processes `tool-call` event (calls Terminal for color output)
   - Stream-json formatter outputs valid LDJSON for each event type
   - All event types are handled without errors

**Verification:** `pnpm vitest run` passes all tests. Each test uses real file system / mock stdout.

---

### Task 2: AI provider layer construction

**Files to create:**
- `src/provider.ts` - Provider layer builder
- `src/provider.test.ts` - Provider layer tests (note: vitest config includes src/**/*.test.ts)

**Steps:**

1. Create `src/provider.ts`:
   - `buildProviderLayer(config: ProviderConfig): Layer<never, AiError, LanguageModel | EmbeddingModel>`
   - Match on `config.type`:
     - `"openai-compat"`: use `OpenAiClient.layer` + `OpenAiLanguageModel.layer` from `@effect/ai-openai-compat`, baseUrl defaults to `https://api.openai.com/v1`
     - `"openai"`: use `OpenAiClient.layer` + `OpenAiLanguageModel.layer` from `@effect/ai-openai`
     - `"anthropic"`: use `AnthropicClient.layer` + `AnthropicLanguageModel.layer` from `@effect/ai-anthropic`
     - `"openrouter"`: use `OpenRouterClient.layer` + `OpenRouterLanguageModel.layer` from `@effect/ai-openrouter`
   - Use `Model.make(providerType, modelName, composedLayer)` to add ProviderName and ModelName context
   - Default models: `gpt-4o` for openai/openai-compat, `claude-3-5-sonnet-20241022` for anthropic, `anthropic/claude-3-5-sonnet-20241022` for openrouter
   - Each layer requires: apiKey (from config or env), baseUrl (for openai-compat only), model name

2. **Vitest integration tests for Task 2:**

   `tests/provider.test.ts`:
   - Build layer for `openai-compat` type succeeds (type-checked, may fail at runtime without server)
   - Build layer for `openai` type succeeds
   - Build layer for `anthropic` type succeeds
   - Build layer for `openrouter` type succeeds
   - Invalid provider type is a compile-time error (use type-level test or assert never)
   - Default model is set correctly per provider type

**Verification:** `pnpm vitest run` passes all tests. Layer compilation verifies correct wiring.

---

### Task 3: Tool definitions and toolkit

**Files to create:**
- `src/tools/shell.ts`
- `src/tools/read.ts`
- `src/tools/write.ts`
- `src/tools/edit.ts`
- `src/tools/grep.ts`
- `src/tools/glob.ts`
- `src/tools/webfetch.ts`
- `src/tools/index.ts`
- `src/approval.ts`
- `tests/tools/shell.test.ts`
- `tests/tools/read.test.ts`
- `tests/tools/write.test.ts`
- `tests/tools/edit.test.ts`
- `tests/tools/grep.test.ts`
- `tests/tools/glob.test.ts`
- `tests/tools/webfetch.test.ts`
- `tests/approval.test.ts`

**Steps:**

1. Create `src/tools/shell.ts`:
   - Define tool using Effect Schema:
     ```ts
     const ShellParameters = Schema.Struct({ command: Schema.String })
     const ShellTool = Tool.make("shell", {
       description: "Execute a shell command",
       parameters: ShellParameters,
       success: Schema.String,
     })
     ```
   - Handler: uses `ChildProcessSpawner` to spawn `bash -c <command>`, 5 minute timeout
   - Captures stdout + stderr, returns combined output as string
   - Error case: command fails, return error message

2. Create `src/tools/read.ts`:
   - Define tool using Effect Schema:
     ```ts
     const ReadParameters = Schema.Struct({ filePath: Schema.String })
     const ReadTool = Tool.make("read", {
       description: "Read a file's contents",
       parameters: ReadParameters,
       success: Schema.String,
     })
     ```
   - Handler: uses `FileSystem` to read file as string
   - Error case: file not found or read error, return error message

3. Create `src/tools/write.ts`:
   - Define tool using Effect Schema:
     ```ts
     const WriteParameters = Schema.Struct({
       filePath: Schema.String,
       content: Schema.String,
     })
     const WriteTool = Tool.make("write", {
       description: "Write content to a file",
       parameters: WriteParameters,
       success: Schema.String,
     })
     ```
   - Handler: creates parent directories via `Path`, writes file via `FileSystem`
   - Returns success message with file path

4. Create `src/tools/edit.ts`:
   - Define tool using Effect Schema:
     ```ts
     const EditParameters = Schema.Struct({
       filePath: Schema.String,
       oldString: Schema.String,
       newString: Schema.String,
     })
     const EditTool = Tool.make("edit", {
       description: "Edit a file by replacing text",
       parameters: EditParameters,
       success: Schema.String,
     })
     ```
   - Handler: reads file, finds `oldString` exactly (must match), replaces with `newString`, writes back
   - Error case: `oldString` not found in file, return error message

5. Create `src/tools/grep.ts`:
   - Define tool using Effect Schema:
     ```ts
     const GrepParameters = Schema.Struct({
       pattern: Schema.String,
       path: Schema.String,
     })
     const GrepTool = Tool.make("grep", {
       description: "Search for text patterns in files",
       parameters: GrepParameters,
       success: Schema.Array(Schema.String),
     })
     ```
   - Handler: runs `rg --hidden --no-heading --line-number <pattern> <path>` via shell
   - Returns array of matching lines in `file:line:content` format
   - Error case: no matches, return empty array

6. Create `src/tools/glob.ts`:
   - Define tool using Effect Schema:
     ```ts
     const GlobParameters = Schema.Struct({
       pattern: Schema.String,
       path: Schema.String,
     })
     const GlobTool = Tool.make("glob", {
       description: "Find files matching a glob pattern",
       parameters: GlobParameters,
       success: Schema.Array(Schema.String),
     })
     ```
   - Handler: uses shell with `find <path> -name "<pattern>" -type f` (or implement with FileSystem)
   - Returns newline-separated file paths (as single string that caller splits)

7. Create `src/tools/webfetch.ts`:
   - Define tool using Effect Schema:
     ```ts
     const WebFetchParameters = Schema.Struct({
       url: Schema.String,
       format: Schema.Literal("markdown", "text"),
     })
     const WebFetchTool = Tool.make("webfetch", {
       description: "Fetch web content from a URL",
       parameters: WebFetchParameters,
       success: Schema.String,
     })
     ```
   - Handler: uses `HttpClient` to GET the URL
   - Returns content as-is (markdown format just returns content, text format returns content)
   - Error case: fetch fails, return error message

8. Create `src/tools/index.ts`:
   - `Toolkit.make(shell, read, write, edit, grep, glob, webfetch)`
   - `MyToolkitLayer = Toolkit.toLayer({ shell: shellHandler, read: readHandler, ... })`
   - Export `MyToolkit` and `MyToolkitLayer`

9. Create `src/approval.ts`:
   - `needsApproval(toolName: string, mode: ApprovalMode): boolean`
   - `none`: always returns false
   - `dangerous`: returns true for `shell`, `write`, `edit`; false for others
   - `all`: always returns true

10. **Vitest integration tests for Task 3:**

    Each test file uses a temp directory created via `fs.mkdtemp` and cleaned up after.

    `tests/tools/read.test.ts`:
    - Read existing file returns file contents
    - Read non-existent file returns error message

    `tests/tools/write.test.ts`:
    - Write creates new file with correct content
    - Write overwrites existing file
    - Write creates parent directories

    `tests/tools/edit.test.ts`:
    - Edit replaces `oldString` with `newString` in file
    - Edit returns error when `oldString` not found in file
    - Edit returns error when file doesn't exist

    `tests/tools/grep.test.ts`:
    - Grep finds matches in file
    - Grep returns empty array when no matches

    `tests/tools/glob.test.ts`:
    - Glob finds files matching `*.ts` pattern
    - Glob returns empty array when no matches

    `tests/tools/shell.test.ts`:
    - Shell executes `echo hello` and returns output
    - Shell command fails with non-zero exit, returns error message

    `tests/tools/webfetch.test.ts` (may skip if no network):
    - Fetch `https://example.com` returns content
    - Fetch fails for invalid URL, returns error message

    `tests/approval.test.ts`:
    - `needsApproval("shell", "none")` returns false
    - `needsApproval("read", "none")` returns false
    - `needsApproval("shell", "dangerous")` returns true
    - `needsApproval("read", "dangerous")` returns false
    - `needsApproval("write", "dangerous")` returns true
    - `needsApproval("shell", "all")` returns true
    - `needsApproval("read", "all")` returns true

**Verification:** `pnpm vitest run` passes all tests. Each tool works against real file system and shell.

---

### Task 4: Agent loop with tool-call resolution, approval flow, and session auto-save

**Files to create/modify:**
- `src/agent.ts` - Core agent loop
- Update `src/index.ts` - Wire agent into CLI handler
- Update `src/session.ts` - Add auto-save trigger
- `tests/agent.test.ts` - Agent loop tests

**Steps:**

1. Create `src/agent.ts`:
   - `runAgent(prompt: string, session: Session, config: Config, providerLayer: Layer, toolkitLayer: Layer): Stream<OutputEvent, AiError | ToolError>`
   - Input: prompt string (new user message to add to session)
   - Session is updated in-place (messages appended)
   - Agent loop:
     ```
     messages = session.messages (already includes history if resuming)
     if session.messages is empty and config.systemPrompt:
       prepend system message to messages
     turns = 0
     while turns < config.maxTurns:
       1. Call LanguageModel.streamText with:
          - prompt: messages
          - toolkit: MyToolkit
       2. Iterate over stream events:
          - text-delta: emit {type: "text-delta", delta}, append to text buffer
          - tool-call: emit {type: "tool-call", id, name, params}, then handle
          - tool-result: emit {type: "tool-result", id, name, result, isError}
          - finish: emit {type: "finish", text}, saveSession, return
       3. For each tool-call event:
          a. Check needsApproval(name, config.approvalMode)
          b. If needs approval and mode is dangerous/all: emit approval-request, read response from input
          c. If rejected: emit tool-result with error "Tool execution rejected by user"
          d. If approved: execute handler, emit tool-result
          e. Add tool result as assistant message to messages
       4. After handling all tool calls, if no finish event, loop continues with updated messages
       5. If turns >= maxTurns: emit error and exit
     ```

2. Session auto-save:
   - After each tool result is added to messages, call `saveSession(session)`
   - After final assistant message (finish), call `saveSession(session)`

3. Update `src/index.ts` handler:
   - Build provider layer from config
   - Build toolkit layer with handlers and approval mode from config
   - Run agent stream, pipe events through formatter
   - Handle errors: if error event, write to stderr and exit non-zero
   - On SIGINT/SIGTERM: save session before exiting

4. **Vitest integration tests for Task 4:**

   `tests/agent.test.ts`:
   - Mock LLM (via custom `LanguageModel` implementation) returns text response only → agent emits finish event, no tool calls
   - Mock LLM returns tool call, then on second call returns text → agent executes tool, continues, emits finish
   - `approvalMode = "all"` + tool call → agent emits approval-request event
   - `maxTurns = 1` → agent exits after one LLM call even with tool calls pending
   - Session messages are persisted after agent completes (load from file, verify tool result messages present)

**Verification:** `pnpm vitest run` passes all tests. Agent loop terminates correctly. Tool calls execute. Approval gates work. Session persists.

---

### Task 5: Output formatters and final CLI wiring

**Files to modify:**
- `src/output.ts` - Ensure formatters handle all event types correctly
- `src/index.ts` - Final integration, all features wired together
- `tests/cli.test.ts` - CLI integration tests

**Steps:**

1. Refine `src/output.ts` formatters:
   - Text formatter:
     - `text-delta`: write delta to stdout (no newline)
     - `tool-call`: print `> [name]([params summary])` in blue using Terminal
     - `tool-result`: print result (truncate if very long)
     - `tool-approval-request`: print `Tool [name] requires approval. Allow? (y/n)` and read line from stdin
     - `finish`: print final text (already streamed)
     - `error`: print error message in red
   - Stream-json formatter:
     - Output one JSON object per line (LDJSON)
     - Each object has `type` field and relevant payload fields
     - Event types map to format like Claude Code's stream-json:
       - `{"type":"assistant","content":[{"type":"text","text":"..."}]}`
       - `{"type":"tool_use","name":"read","input":{"filePath":"..."}}`
       - `{"type":"tool_result","content":"..."}`
     - Use `JSON.stringify` for each event

2. Final integration in `src/index.ts`:
   - For `--print` mode: run agent to completion, exit 0 on success, exit 1 on error
   - For non-interactive: same behavior (no TTY prompts)
   - For stdin prompt: read all of stdin as the user message when `--prompt` not provided
   - For approval requests in non-interactive mode with dangerous/all: auto-reject if no stdin available (or fail gracefully)
   - Signal handlers for graceful shutdown

3. Subcommand implementations:
   - `session list`: read `.prodigy-coder/sessions/` directory, list files with timestamps
   - `session delete <id>`: delete `.prodigy-coder/sessions/<id>.json`, confirm deletion
   - `config show`: print config JSON with API keys masked as `***`

4. **Vitest integration tests for Task 5:**

   `tests/cli.test.ts`:
   - `Command.runWith(prodigy, {...}).run(["--help"])` succeeds and output contains expected flags
   - `Command.runWith(prodigy, {...}).run(["session", "list"])` returns empty list when no sessions
   - `Command.runWith(prodigy, {...}).run(["config", "show"])` returns JSON with masked API keys
   - Full pipeline test: run agent with mock provider (returns text only), verify stream-json output is parseable LDJSON
   - `--model` flag is passed through to provider layer (verify via mock)
   - `--max-turns 1` causes agent to exit after one turn
   - Session resume: create session, add message, load via `--session` flag, verify history included

**Verification:** `pnpm vitest run` passes all tests. CLI fully functional.

---

## Testing Plan

### Approach: Vitest integration tests per task, unit tests only for edge cases

### Task 1 Tests (config, session, output)
- Config loading precedence: file < env vars
- Session create/save/load/delete roundtrip
- Output formatters produce correct format

### Task 2 Tests (provider)
- All 4 provider types build without type errors
- Default model selection per provider type

### Task 3 Tests (tools + approval)
- Each tool executes against real file system/shell
- Approval gates correct tools per mode

### Task 4 Tests (agent)
- Single-turn agent (no tools) → finish
- Two-turn agent (tool then text) → finish
- Approval requested for dangerous tools
- maxTurns enforcement
- Session auto-save after tool result

### Task 5 Tests (CLI + integration)
- CLI command parsing and subcommands
- Stream output in both formats
- Flag overrides work
- Session resume from ID

## Spec Readiness Checklist

- [x] All requirements are clearly defined (no unanswered questions)
- [x] All tasks are atomic (each leaves codebase in working state)
- [x] All tasks include vitest integration tests (not separate test tasks)
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable
- [x] Rollback plan exists