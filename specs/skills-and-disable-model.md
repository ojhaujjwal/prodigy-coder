# Tech Spec: Skills System

## Summary

Add a Command Code/Cursor-style skill system. `SKILL.md` files are auto-discovered from `.agents/skills/` (CWD + `~/.agents/skills/`). Skills with `disable_model_invocation: false` (default) appear in the system prompt index and the LLM can `load_skill` them on demand. Skills with `disable_model_invocation: true` are excluded from the system prompt — only invokable via the manual `/skill <name> <prompt>` slash command, which injects skill content as a separate user message before the actual prompt, then proceeds with the normal agent loop. `/skill` works for any skill (disabled or not).

## Context / Current State

prodigy-coder has no skill system. The agent loop (`src/agent.ts:runAgent`) assembles a system prompt from `AGENTS.md` + `--system-prompt` and enters a multi-turn LLM loop with an 8-tool toolkit (`src/tools/index.ts:AgenticToolkit`). The CLI entry point (`src/index.ts:runAgent`) orchestrates config loading, session creation, provider construction, and agent execution.

Key contracts:
- `AgentConfig = { session: Session; config: ConfigData }` (`src/agent.ts:12-15`)
- `runAgent(promptText: string, agentConfig: AgentConfig, providerLayer)` — user prompt pushed at line 66: `messages.push({ role: "user", content: promptText })`
- `combinedSystemPrompt = [agentsMd, explicitPrompt].filter(Boolean).join("\n\n")` (`src/index.ts:36`)
- `ConfigData.systemPrompt :: Schema.optional(Schema.String)` (`src/config.ts:35`)
- `AgenticToolkit` is 8 tools: shell, read, write, edit, grep, glob, webfetch, ask_user (`src/tools/index.ts:16-25`)
- `makeToolkitLayer(config)` wraps each handler with approval/logging and returns `Layer<HandlersFor<AgenticToolkit.tools>>` (`src/tools/index.ts:67-80`)
- `AgenticToolkitLayer` is a convenience layer with all handlers + `DefaultApprovalGateLayer` (`src/tools/index.ts:103-112`)

## Goals

1. Auto-discover `SKILL.md` files from `.agents/skills/**/SKILL.md` (CWD) and `~/.agents/skills/**/SKILL.md` (home), merge with CWD-wins collision
2. Parse `disable_model_invocation` boolean from SKILL.md YAML frontmatter (defaults to `false` when absent)
3. Skills with `disable_model_invocation: false` → injected into system prompt as compact index; LLM can `load_skill("name")` for full content
4. Skills with `disable_model_invocation: true` → excluded from system prompt; LLM never auto-discovers them
5. `/skill <name> <prompt>` parses from input, loads skill content, sends it as a **separate user message** before the actual prompt, then continues normal agent loop. Works for any skill (disabled or not).
6. `/skill <name>` with no remaining prompt → usage error, exit without LLM
7. `/skill <nonexistent> <prompt>` → not-found error, exit without LLM
8. Regular prompt (no `/skill` prefix) → normal agent flow

## Non-Goals

- No CLI flag for disable-model-invocation (it's a per-skill frontmatter field)
- No `/skills` list command
- No skill enable/disable flags beyond frontmatter
- No stdin piping of prompts
- No changes to `ConfigData` schema
- No changes to `Session` or `Message` types

## Invariants

- Skill file parsing errors never crash — malformed skills are silently skipped, logged at debug
- No skill files found is an empty list, not an error (no error message, just zero skills)
- `/skill <nonexistent>` → prints error and exits without LLM
- `/skill <name>` with no prompt → prints usage and exits without LLM
- `/skill <name> <prompt>` always invokes the LLM — never a read-only display
- Skill content injected via `/skill` is a user message, not system prompt
- `load_skill` tool returns content from in-memory `SkillsRepo` — no filesystem I/O at call time
- `load_skill` is never wrapped in `withApproval` — always auto-executes
- `load_skill` has no deduplication — LLM sees prior results in conversation

## Design Constraints

- Must use Effect conventions: `Effect.fn`, `Effect.gen`, services via `Context.Service`, layers via `Layer.effect`
- Must follow LLMS.md: `Schema` for validation, `Predicate` (not hand-rolled guards), `Effect.fn` for functions returning Effect
- Tests use `@effect/vitest` with `it.effect` for all Effect-returning tests (per `specs/guides/testing-with-effect.md`)
- CLI flags use `effect/unstable/cli`
- No new npm dependencies — parse YAML frontmatter with string splitting and regex
- Tests through full application pipeline (taste: integration/e2e style, no direct internal helper calls)

## Decisions

| Decision | Resolution |
|----------|------------|
| Skill discovery | CWD `.agents/skills/` + `~/.agents/skills/`, CWD wins on collision |
| `skillsRepoLayer` in `makeToolkitLayer` | Required parameter |
| `AgenticToolkitLayer` + SkillsRepo | `SkillsRepo` is a layer dependency. Callers provide via `Layer.provide`. |
| `load_skill` approval | Never approved — not wrapped in `withApproval` |
| `load_skill` deduplication | None |
| `load_skill` error on unknown skill | `AiError` with message including auto-invokable skill names |
| `disable_model_invocation` | YAML frontmatter field per-skill, defaults to `false` |
| `/skill <name> <prompt>` injection | Skill content as separate user message, actual prompt as second user message |
| `/skill` missing skill or no prompt | Error/usage, exit without LLM |

## Alternatives Considered

### Option A: `/skill` exits without LLM (rejected)

`/skill <name>` shows content and exits. No LLM interaction.

**Rejected:** User wants `/skill <name> <prompt>` to load skill content and send it to the LLM as context for reasoning.

### Option B: `/skill` injects into system prompt (rejected)

**Rejected:** User chose separate user message for cleaner separation.

### Option C: `/skill` injects as separate user message (Selected)

Two user messages: skill content first, actual prompt second. LLM sees skill as context.

## Proposed Design

### SKILL.md Frontmatter Format

```markdown
---
name: my-skill
description: A test skill for verification.
disable_model_invocation: true    # optional, defaults to false
---

## Instructions
Always use Effect.gen.
```

### Module: `src/skills.ts`

```ts
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly source: "cwd" | "home";
  readonly disableModelInvocation: boolean;
}

export class SkillsRepo extends Context.Service<SkillsRepo, {
  readonly all: Effect.Effect<readonly Skill[]>;
  readonly findByName: (name: string) => Effect.Effect<Option.Option<Skill>>;
  readonly autoInvokable: Effect.Effect<readonly Skill[]>;
}>()("prodigy-coder/SkillsRepo") {
  static readonly layer = (skills: readonly Skill[]) =>
    Layer.succeed(SkillsRepo, SkillsRepo.of({
      all: Effect.succeed(skills),
      findByName: (name: string) =>
        Effect.succeed(Option.fromNullable(skills.find((s) => s.name === name) ?? null)),
      autoInvokable: Effect.succeed(skills.filter((s) => !s.disableModelInvocation))
    }));
}

export const discoverSkills: Effect.Effect<readonly Skill[], never, FileSystem.FileSystem | Path.Path>;
export const formatSkillsIndex: (skills: readonly Skill[]) => string;
export const formatSkillContent: (skill: Skill) => string;
// → "# Skill: {name}\n\n{content}"
```

**`formatSkillsIndex`:** Compact list of auto-invokable skills only:
```
Available Skills (use load_skill to view full content):
- my-skill: A test skill for verification.
- jsdocs: Write Effect JSDoc comments.
```

**`formatSkillContent`:** Full content for injection as user message:
```
# Skill: grill-me

Interview me relentlessly about every aspect...
```

### Module: `src/tools/loadSkill.ts`

Same as before. `LoadSkillTool` with `SkillsRepo` dependency, `failureMode: "return"`, error includes auto-invokable names.

### Module: `src/slash-commands.ts`

Pure parsing only — no effectful execution:

```ts
type SlashCommand =
  | { readonly _tag: "SkillPrefixed"; readonly name: string; readonly prompt: string }
  | { readonly _tag: "NotSlashCommand" };

// Regex: /^\/skill\s+(\S+)(?:\s+(.+))?$/s
export const parseSlashCommand: (input: string) => SlashCommand;
```

No `executeSlashCommand` — the main command handler decides what to do with the parsed result.

### Modifications: `src/agent.ts`

**Signature change:** `promptText: string` → `userMessages: readonly string[]`

```ts
export const runAgent = (
  userMessages: readonly string[],
  agentConfig: AgentConfig,
  providerLayer: Layer.Layer<LanguageModel.LanguageModel | Tool.HandlersFor<typeof AgenticToolkit.tools>>
) =>
  Effect.gen(function* () {
    const { session, config } = agentConfig;
    const messages: Message[] = [...session.messages];

    if (messages.length === 0 && config.systemPrompt) {
      messages.push({ role: "system", content: config.systemPrompt });
    }

    for (const msg of userMessages) {
      messages.push({ role: "user", content: msg });
    }

    // ... rest of agent loop unchanged ...
  });
```

### Modifications: `src/index.ts`

**Pre-agent slash command handling:**

```ts
const promptText = Option.getOrElse(prompt, () => "");
if (!promptText) {
  yield* Console.log("No prompt provided. Use --prompt or pipe input.");
  return;
}

let userMessages: readonly string[];
const slashCmd = parseSlashCommand(promptText);

if (slashCmd._tag === "SkillPrefixed") {
  const skills = yield* discoverSkills;
  const skill = skills.find((s) => s.name === slashCmd.name);
  if (!skill) {
    yield* Console.log(`Skill '${slashCmd.name}' not found.`);
    return;
  }
  if (!slashCmd.prompt) {
    yield* Console.log("Usage: /skill <name> <prompt> — Load a skill and run the agent.");
    return;
  }
  userMessages = [formatSkillContent(skill), slashCmd.prompt];
} else {
  userMessages = [promptText];
}

// ... config, session, provider setup continues, then:
const sessionRepo = yield* SessionRepo;
const fs = yield* FileSystem.FileSystem;
const agentsMdOption = yield* loadAgentsMd(fs);
const agentsMd = Option.getOrElse(agentsMdOption, () => DEFAULT_AGENTS_MD);
const explicitPrompt = config.systemPrompt ?? "";

const skills = yield* discoverSkills;        // already called above, but ok to call again
const autoInvokable = skills.filter((s) => !s.disableModelInvocation);
const skillsIndex = autoInvokable.length > 0 ? formatSkillsIndex(autoInvokable) : "";
const combinedSystemPrompt = [agentsMd, skillsIndex, explicitPrompt].filter(Boolean).join("\n\n");

const sessionEffect = Option.match(sessionId, {
  onNone: () => sessionRepo.create(combinedSystemPrompt),
  onSome: (id) => sessionRepo.load(id).pipe(Effect.orDie)
});
const session = yield* sessionEffect;

const agentConfig: AgentConfig = { session, config: { ...config, systemPrompt: combinedSystemPrompt } };

const skillsRepoLayer = SkillsRepo.layer(skills);
const providerLayer = Layer.mergeAll(
  buildProviderLayer(config.provider),
  makeToolkitLayer({ approvalMode: config.approvalMode, nonInteractive: config.nonInteractive ?? false, skillsRepoLayer }),
  skillsRepoLayer
).pipe(Layer.provide(FetchHttpClient.layer));

const outputEvents = yield* runAgentLoop(userMessages, agentConfig, providerLayer);
yield* sessionRepo.save(session);
return { outputEvents, sessionId: session.id };
```

Note: `discoverSkills` is called once for the slash-command check and again in the agent setup. That's fine — the second call could be cached, but `FileSystem` reads are cheap and skills are a small set.

### Modifications: `src/tools/index.ts`

Same as before — add `LoadSkillTool` to toolkit, update `makeToolkitLayer` to require `skillsRepoLayer`, update `AgenticToolkitLayer` to declare `SkillsRepo` as layer dependency.

## Domain Model and Types

| Type | File | Purpose |
|------|------|---------|
| `Skill` | `src/skills.ts` | Parsed skill: name, description, content, source, disableModelInvocation |
| `SkillsRepo` | `src/skills.ts` | Service: `all`, `findByName(name)`, `autoInvokable` |
| `LoadSkillTool` | `src/tools/loadSkill.ts` | Tool: LLM loads full skill content by name |
| `SlashCommand` | `src/slash-commands.ts` | ADT: `SkillPrefixed(name, prompt)` \| `NotSlashCommand` |

**Changed types:**

| Type | File | Change |
|------|------|--------|
| `runAgent` | `src/agent.ts` | `promptText: string` → `userMessages: readonly string[]` |

## Call Stacks and Data Flow

### Flow A: `/skill grill-me please grill me`

```
prodigy --prompt "/skill grill-me please grill me"
  → mainCommand handler
  → parseSlashCommand → { _tag: "SkillPrefixed", name: "grill-me", prompt: "please grill me" }
  → discoverSkills(fs, path) → [...Skill("grill-me", ...), ...]
  → skill found ✓
  → prompt non-empty ✓
  → formatSkillContent(grillMeSkill) → "# Skill: grill-me\n\nInterview me relentlessly..."
  → userMessages = [
      "# Skill: grill-me\n\nInterview me relentlessly...",
      "please grill me"
    ]
  → loadConfig, loadAgentsMd, discoverSkills (again), formatSkillsIndex(autoInvokable)
  → combinedSystemPrompt = [AGENTS.md, skillsIndex, --system-prompt]
  → sessionRepo.create(combinedSystemPrompt) → Session
  → providerLayer with skillsRepoLayer
  → runAgent(userMessages, agentConfig, providerLayer)
    → messages.push({ role: "system", content: combinedSystemPrompt })
    → messages.push({ role: "user", content: "# Skill: grill-me\n\n..." })
    → messages.push({ role: "user", content: "please grill me" })
    → LLM stream with full toolkit (including load_skill)
```

### Flow B: `/skill grill-me` (no prompt)

```
prodigy --prompt "/skill grill-me"
  → parseSlashCommand → { _tag: "SkillPrefixed", name: "grill-me", prompt: "" }
  → discoverSkills → found "grill-me"
  → prompt is empty → Console.log("Usage: /skill <name> <prompt>...")
  → return (no LLM, no session)
```

### Flow C: `/skill nonexistent please help`

```
prodigy --prompt "/skill nonexistent please help"
  → parseSlashCommand → { _tag: "SkillPrefixed", name: "nonexistent", prompt: "please help" }
  → discoverSkills → no match
  → Console.log("Skill 'nonexistent' not found.")
  → return (no LLM, no session)
```

### Flow D: `build a REST API` (normal prompt)

```
prodigy --prompt "build a REST API"
  → parseSlashCommand → { _tag: "NotSlashCommand" }
  → userMessages = ["build a REST API"]
  → ... normal agent flow with skills index in system prompt ...
  → runAgent(["build a REST API"], agentConfig, providerLayer)
```

### Flow E: LLM invokes `load_skill`

```
LLM emits: tool-call(load_skill, { name: "grill-me" })
  → loadSkillHandler (not wrapped in withApproval)
  → SkillsRepo.findByName("grill-me") → Option.some(Skill)
  → return "# Skill: grill-me\n\nInterview me relentlessly..."
  → tool-result message added to conversation
```

### Flow F: LLM invokes `load_skill` for unknown name

```
LLM emits: tool-call(load_skill, { name: "nonexistent" })
  → SkillsRepo.findByName("nonexistent") → Option.none()
  → SkillsRepo.autoInvokable → ["jsdocs", "my-skill"]
  → return AiError { message: "Skill 'nonexistent' not found. Available skills: jsdocs, my-skill" }
  → failureMode: "return" → LLM sees error
```

### Failure Flow

```
discoverSkills:
  .agents/skills/ not found    → empty Skill[], no error
  ~/.agents/skills/ not found   → empty Skill[], no error
  subdir without SKILL.md      → skip, Effect.logDebug
  bad YAML                     → skip, Effect.logDebug
  unreadable file               → skip, Effect.logDebug

/skill <nonexistent>:
  → Console.log not-found → return (no LLM)

/skill <name> (no prompt):
  → Console.log usage → return (no LLM)

load_skill tool (unknown):
  → AiError with auto-invokable names → LLM self-corrects
```

## Files to Add / Change / Delete

| File | Action | Responsibility |
|------|--------|---------------|
| `src/skills.ts` | **Add** | `Skill` type, `SkillsRepo` service, `discoverSkills`, `formatSkillsIndex`, `formatSkillContent`, `parseFrontmatter` |
| `src/tools/loadSkill.ts` | **Add** | `LoadSkillTool`, `LoadSkillParameters`, `loadSkillHandler` |
| `src/slash-commands.ts` | **Add** | `SlashCommand` ADT, `parseSlashCommand` (pure function only) |
| `src/agent.ts` | **Change** | `runAgent` signature: `promptText: string` → `userMessages: readonly string[]` |
| `src/index.ts` | **Change** | Add slash-command pre-check, wire `discoverSkills` + `formatSkillsIndex` into `runAgent`, wire `skillsRepoLayer` |
| `src/tools/index.ts` | **Change** | Add `LoadSkillTool` to `AgenticToolkit`, update `makeToolkitLayer` (require `skillsRepoLayer`), update `AgenticToolkitLayer` (declare `SkillsRepo` dependency) |
| `src/__integration__/agent-integration.test.ts` | **Change** | Update all `runAgent` call sites to array param. Add: skills index test, `load_skill` tool tests, multi-message skill injection test |
| `src/__integration__/cli-integration.test.ts` | **Change** | Add: `/skill <name> <prompt>` goes to agent, `/skill <nonexistent>` prints error, `/skill <name>` (no prompt) prints usage |

## RGR TDD Test Plan

Tests through **full application pipeline**: CLI via `Command.runWith(app, ...)`, agent via `runAgent()` with mock server.

### Slice 1: Update `runAgent` signature + all existing call sites

**Red:** All existing tests fail because `runAgent` now expects `string[]` not `string`.
```ts
// Every call site changes from:
runAgentWithMockServer("hello", [...])
// to:
runAgentWithMockServer(["hello"], [...])
```
**Green:** Update `runAgent` signature. Update all call sites in `agent-integration.test.ts`. Update `runAgentWithMockServer` helper. All existing tests pass.

### Slice 2: Normal prompt not intercepted by slash parser

**Red:** Run normal prompt through CLI. Verify it enters agent loop.
```ts
// cli-integration.test.ts
it.effect("normal prompt not intercepted by slash parser", () =>
  Effect.gen(function* () {
    // Since we can't easily mock the LLM in CLI tests, verify the
    // "No prompt provided" message is NOT shown (meaning it didn't bail early)
    // Actually, CLI tests with real LLM calls are hard. Use agent integration instead.
  })
);
```
Actually, the real test here is: existing agent tests still work with the new `[prompt]` signature. The slash parser returns `NotSlashCommand` for normal text, so the main handler proceeds as before. Slice 1 covers this.

**Green:** Implement `parseSlashCommand` — returns `NotSlashCommand` for non-`/skill` input.

### Slice 3: `/skill <name> <prompt>` sends two user messages

**Red:** Create skill, run agent with parsed prompt, verify mock server received two user messages.
```ts
// agent-integration.test.ts
it.effect("'/skill <name> <prompt>' sends skill content as first user message", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(".agents/skills/grill-me", { recursive: true });
    yield* fs.writeFileString(".agents/skills/grill-me/SKILL.md",
      "---\nname: grill-me\ndescription: Grills you.\n---\n\nInterview me relentlessly.");

    const { server } = yield* runAgentWithMockServer(
      ["# Skill: grill-me\n\nInterview me relentlessly.", "please grill me"],
      [[{ type: "text", content: "Ok, let's start." }]]
    );

    const requestBody = JSON.stringify(server.calls[0]);
    expect(requestBody).toContain("Interview me relentlessly");
    expect(requestBody).toContain("please grill me");
  }).pipe(Effect.provide(BunServices.layer))
);
```
**Green:** Implement `discoverSkills` (CWD), `parseFrontmatter`, `formatSkillContent`. Add slash-command pre-check to main handler that constructs `userMessages = [formatSkillContent(skill), prompt]`.

### Slice 4: `/skill <nonexistent>` prints error

**Red:** CLI test.
```ts
// cli-integration.test.ts
it.effect("'/skill <nonexistent>' prints not-found", () =>
  Effect.gen(function* () {
    yield* runApp(["prodigy", "--prompt", "/skill nonexistent do stuff"]);
    const logs = yield* TestConsole.logLines;
    expect(logs.some((log) => String(log).includes("not found"))).toBe(true);
  }).pipe(Effect.provide(combinedLayer))
);
```
**Green:** Handle missing-skill in slash-command pre-check.

### Slice 5: `/skill <name>` with no prompt prints usage

**Red:** CLI test.
```ts
it.effect("'/skill <name>' with no prompt prints usage", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(".agents/skills/grill-me", { recursive: true });
    yield* fs.writeFileString(".agents/skills/grill-me/SKILL.md",
      "---\nname: grill-me\ndescription: Grills.\n---\n\nContent.");

    yield* runApp(["prodigy", "--prompt", "/skill grill-me"]);
    const logs = yield* TestConsole.logLines;
    expect(logs.some((log) => String(log).includes("Usage"))).toBe(true);
  }).pipe(Effect.provide(combinedLayer))
);
```
**Green:** Handle empty-prompt case.

### Slice 6: System prompt includes only non-disabled skills

**Red:** Create visible + hidden skills. Run normal prompt. Verify mock server.
```ts
it.effect("system prompt includes only non-disabled skills", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(".agents/skills/visible-skill", { recursive: true });
    yield* fs.writeFileString(".agents/skills/visible-skill/SKILL.md",
      "---\nname: visible-skill\ndescription: Should appear.\n---\n\nContent.");
    yield* fs.makeDirectory(".agents/skills/hidden-skill", { recursive: true });
    yield* fs.writeFileString(".agents/skills/hidden-skill/SKILL.md",
      "---\nname: hidden-skill\ndescription: Should NOT.\ndisable_model_invocation: true\n---\n\nContent.");

    const { server } = yield* runAgentWithMockServer(["hello"], [[{ type: "text", content: "Hi" }]]);
    const requestBody = JSON.stringify(server.calls[0]);
    expect(requestBody).toContain("visible-skill");
    expect(requestBody).not.toContain("hidden-skill");
  }).pipe(Effect.provide(BunServices.layer))
);
```
**Green:** Parse `disable_model_invocation` in `parseFrontmatter`. Filter in `formatSkillsIndex`. Wire into `runAgent` function.

### Slice 7: `/skill` works for disabled skills too

**Red:** `/skill hidden-skill please help` should send content as user message even though hidden from system prompt.
```ts
it.effect("'/skill <disabled> <prompt>' injects disabled skill content", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(".agents/skills/hidden-skill", { recursive: true });
    yield* fs.writeFileString(".agents/skills/hidden-skill/SKILL.md",
      "---\nname: hidden-skill\ndescription: Hidden.\ndisable_model_invocation: true\n---\n\nManual only content.");

    const { server } = yield* runAgentWithMockServer(
      ["# Skill: hidden-skill\n\nManual only content.", "do the thing"],
      [[{ type: "text", content: "Done" }]]
    );

    const requestBody = JSON.stringify(server.calls[0]);
    expect(requestBody).toContain("Manual only content");
  }).pipe(Effect.provide(BunServices.layer))
);
```
**Green:** Slash-command pre-check searches ALL skills (not just auto-invokable).

### Slice 8: `load_skill` tool (success + error)

**Red:** Two tests — success path and unknown-name error path.
```ts
// Success
it.effect("load_skill tool returns full skill content", () => { ... });
// Error with auto-invokable list only
it.effect("load_skill error lists only auto-invokable skills", () => { ... });
```
**Green:** Implement `LoadSkillTool`, `loadSkillHandler`, `SkillsRepo`. Add to `AgenticToolkit`. Update `makeToolkitLayer`.

### Slice 9: Home directory skills + CWD shadowing

**Red:** CLI tests for `~/.agents/skills/` discovery + CWD-wins collision.
```ts
it.effect("discovers skills from ~/.agents/skills/", () => { ... });
it.effect("CWD skills shadow home skills", () => { ... });
```
**Green:** Add home path to `discoverSkills`. Implement CWD-wins merge.

### Slice 10: Run full CI
```bash
bun run ci  # lint, typecheck, tests
```

## Risks and Open Questions

- **Risk:** `runAgent` signature change breaks all existing call sites. Mitigation: mechanical grep-and-update — all tests and the one production call site.
- **Risk:** `/skill` with multi-word skill names is ambiguous (skill name is first non-whitespace token only). Mitigation: skill names match directory names, which are kebab-case single tokens.
- **Risk:** `discoverSkills` called twice in the main handler (once for slash check, once for system prompt). Mitigation: harmless — FileSystem reads are cheap, skills are a small set. Future optimization can cache the result.
