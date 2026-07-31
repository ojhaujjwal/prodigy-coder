# Enable `strictEffectProvide` and consolidate layer provision to the edge

## Goal
Flip `strictEffectProvide` from `"off"` → `"error"` in `tsconfig.json` and fix all 87 resulting violations by adopting the Effect best practice: **construct one Layer and provide it to the program at the edge once** — not `Effect.provide` scattered across the app.

The user explicitly rejected per-line suppression in favor of a **deep structural refactor**.

## The principle
Compose all layers into a single `Layer` at the application/test entry point and `Effect.provide` it once. Inner code should only *declare* requirements (via service types / `Layer.Layer<Rout, E, Rin>`); it must not call `Effect.provide` to satisfy them mid-pipeline. This preserves scope lifetimes and makes the dependency graph explicit at the edge.

## Step 1 — Enable the diagnostic
`tsconfig.json` line 80: change `"strictEffectProvide": "off"` → `"strictEffectProvide": "error"`.

## Step 2 — Test files: use `@effect/vitest` `layer()` shared helper (bucket 1, ~60 errors)

### 2a. Redundant provides — just delete (13 errors)
`src/output.test.ts`: `it.effect` already provides `TestConsole` fresh per test (confirmed in `@effect/vitest` source: `effect: makeTester(flow(Effect.scoped, Effect.provide(TestEnv)))` where `TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())`). Remove every `Effect.provide(testLayer)` and the unused `testLayer` const.

### 2b. Shared static layer → `layer()` helper
These files define one `testLayer` and pipe every `it.effect` through `Effect.provide(testLayer)`. Replace the `describe`+`.pipe(Effect.provide(testLayer))` pattern with `layer(testLayer)("describe name", (it) => { it.effect(...) })` so the layer is built once and shared:

- `src/session.test.ts` (11) — `testLayer = SessionRepo.layer(...).pipe(Layer.provideMerge(bunServicesLayer))`
- `src/tools/shell.test.ts` (4), `src/tools/edit.test.ts` (3), `src/tools/glob.test.ts` (2), `src/tools/grep.test.ts` (2), `src/tools/read.test.ts` (2), `src/tools/write.test.ts` (3) — all `testLayer = bunServicesLayer`
- `src/tools/webfetch.test.ts` (2) — `testLayer = FetchHttpClient.layer`; note second test also chains `Effect.flip`/`Effect.map` — keep those combinators, drop only `Effect.provide(testLayer)`
- `src/__integration__/cli-integration.test.ts` (9) — `combinedLayer`; also the `runApp` helper's `Effect.provide(bunServicesLayer)` at line 12 — see Step 4 for whether that moves into `layer()`
- `src/__integration__/agent-integration.test.ts` (15) — `BunServices.layer` per test (see Step 4 for the inner `runAgentWithMockServer` provide at line 43)
- `src/__integration__/output-integration.test.ts` (2) — `Layer.merge(BunServices.layer, EmptySkillsRepoLayer)`; third test (line 94) already has no provide — leave it

## Step 3 — Library code: stop hiding requirements via mid-pipeline `Effect.provide` (bucket 2, 2 errors)

### 3a. `src/approval-gate.ts:48`
`createApprovalGate` calls `Prompt.run(...).pipe(Effect.provide(BunServices.layer))` to dodge a `Terminal` requirement. Instead: declare `Terminal.Terminal` (or `Terminal` + `Stdio`) in the `approve` effect's requirement type and let it flow up. The entry point already provides `BunServices` (which includes `Terminal`), so the requirement is satisfied at the edge. **Type ripple:** the `ApprovalGate` service interface's `approve` return type widens to `Effect.Effect<boolean, never, Terminal>` (or whatever it needs); check ripple through `withApproval` in `src/tools/index.ts` and callers.

### 3b. `src/http-debug.ts:28`
`appendToLog` calls `Effect.provide(BunServices.layer)` to satisfy `FileSystem`. Instead: drop the `.pipe(Effect.provide(BunServices.layer))` and let `FileSystem.FileSystem` flow up as a requirement of `makeHttpDebugLayer`. **Type ripple:** `makeHttpDebugLayer()` currently returns `Layer.Layer<HttpClient, never, HttpClient>`; it may need `FileSystem` (and `Config`) added to its `Rin`. Check that `src/provider.ts:91` (`Layer.provide(makeHttpDebugLayer())`) and its ultimate consumer (`agent.ts` → `index.ts`) already have `FileSystem`/`Config` in scope (they do — `BunServices` provides `FileSystem`, and `Config` is a runtime service).

## Step 4 — Dynamic entry points / per-test-varying layers (bucket 3, ~15 errors)

These genuinely vary per invocation, so they can't use the static `layer()` helper. Refactor approach:

### 4a. `src/index.ts` — CLI entry (3 errors: lines 202, 244, 260)
- Lines 202 & 244: each subcommand handler pipes through `Effect.provide(loadConfig(...))` to satisfy `AppConfig`. Refactor so `AppConfig` is a declared requirement of each command handler, then provide it once at the single `cli = Command.run(...).pipe(Effect.provide(...))` edge (line 260).
- **Unknown:** whether `--config <path>` can still be honored when `AppConfig` is provided at the edge. The path flag is parsed *inside* the command, but `AppConfig.layer` needs the path *before* the handler runs. Options: (a) `Layer.unwrap` with an Effect that reads the flag then builds the layer (but the flag is part of the command's own parsed input — chicken/egg), (b) keep `loadConfig()` at the edge using a default path and re-resolve if `--config` is passed. **Needs investigation during implementation** — the v3 CLI used per-command provides precisely because the config path comes from the parsed args.
- Line 260: the true edge — `Command.run(app, ...).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, ..., SessionRepo.layer(...), SkillsRepo.layer([]))))`. This is the *one* legitimate `Effect.provide`. **Unknown:** whether `strictEffectProvide` treats the outermost `Command.run` as an entry point (it should — but the diagnostic fires regardless; this may be the one site that still needs `// @effect-diagnostics-next-line`).

### 4b. `src/agent.ts:154` — dynamic `providerLayer` per turn
`runAgent` receives `providerLayer` as an *argument* (built dynamically from config in `index.ts:55-63`) and calls `Effect.provide(fullLayer)` on the LLM stream. The layer is built at the call site (edge-of-`index`) but provided here. Refactor: build the complete layer at `index.ts`'s `runAgent` edge and pass it in already-merged, OR have `runAgent` declare its requirements and provide once at the `index.ts` call site. **Unknown:** the `providerLayer` depends on `config` which is only known after `AppConfig` resolves — so it can't be a static edge layer. May require `Layer.unwrap` over the `AppConfig` effect.

### 4c. `src/agent.ts` integration test helper (line 43, 1 error)
`runAgentWithMockServer` builds `providerLayer` dynamically (mock server URL per test) and calls `runAgent(...).pipe(Effect.provide(EmptySkillsRepoLayer))`. Refactor: merge `EmptySkillsRepoLayer` into the test's shared/edge layer; pass the already-complete layer into `runAgent`.

### 4d. Per-test-varying test layers
- `src/approval-gate.test.ts` (5) — each test builds a different `makeApprovalGateLayer(config)` merged with `BunServices.layer`. Can't share via `layer()` since config varies. **Unknown:** whether `it.live` (which doesn't provide `TestEnv`) + per-test provide is sanctioned, or whether these need restructuring.
- `src/tools/askUser.test.ts` (2) — first test builds a mock Terminal layer (varies per test), second is `BunServices.layer`.
- `src/config.test.ts` (6) — `runWithConfig`/`runWithConfigPath`/`runWithConfigAndEnv` helpers build a layer from a per-test tmp dir + env, then `Effect.provide(...)`. The env/tmp dir is runtime-known, so these can't be static. **Unknown:** same as 4d — the idiomatic Effect pattern for per-test-varying layers under `strictEffectProvide`.

## Flagged unknowns (resolve during implementation)
1. **Does `strictEffectProvide` exempt `Command.run` / `BunRuntime.runMain` as entry points?** The diagnostic text says "if this is an entry point, you can safely disable" — implying the lint *cannot* auto-detect entry points and flags them anyway. If so, `index.ts:260` (the true CLI edge) will still error and need a single `// @effect-diagnostics-next-line effect/strictEffectProvide:off`. This is the one site where suppression is sanctioned.
2. **`--config` flag + edge-provided `AppConfig`** (4a): chicken/egg between parsed-args config path and edge-level layer. Likely needs `Layer.unwrap` or two-phase config loading.
3. **Dynamic `providerLayer`** (4b): depends on `config` known only at runtime; `Layer.unwrap` over `AppConfig` is the likely tool but unverified.
4. **Per-test-varying layers** (4d): no `layer()` equivalent for per-test layers. Need to confirm the idiomatic pattern (possibly `it.live` + provide, or a test-scoped `ManagedRuntime`, or `Layer.unwrap` per test).
5. **Exact requirement types** for 3a/3b: need to determine whether `approval-gate` needs `Terminal.Terminal` or `Terminal.Terminal | Stdio.Stdio`, and whether `makeHttpDebugLayer`'s `Rin` gains `FileSystem.FileSystem | Config.Config`.

## Files to modify
- `tsconfig.json` — flip diagnostic
- `src/index.ts` — consolidate to one edge provide; resolve `--config` + `AppConfig` (unknown 2)
- `src/agent.ts` — stop mid-pipeline `Effect.provide`; declare requirements (unknown 3)
- `src/approval-gate.ts` — declare `Terminal` requirement instead of hiding via `BunServices.layer`
- `src/http-debug.ts` — declare `FileSystem`/`Config` requirement instead of hiding
- `src/provider.ts`, `src/tools/index.ts` — absorb type ripples from 3a/3b
- Test files (bucket 1 + bucket 3): `output.test.ts`, `session.test.ts`, `approval-gate.test.ts`, `config.test.ts`, `tools/*.test.ts`, `__integration__/*.test.ts` — convert to `layer()` where static; resolve per-test-varying pattern (unknown 4)

## Verification
- `bun run ci` (lint + typecheck + tests) must pass with `strictEffectProvide: "error"`.
- Per taste profile: validate via `bun run ci` as the final gate.
- Confirm zero `strictEffectProvide` errors from `npm run typecheck`.
- Confirm no test silently passes due to a lost provide (per `specs/guides/testing-with-effect.md`): spot-check that `it.effect` bodies still execute (e.g. a `Console.log` smoke test or an assertion that would fail if the effect didn't run).
