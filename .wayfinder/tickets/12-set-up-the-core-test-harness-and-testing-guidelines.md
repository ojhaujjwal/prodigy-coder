---
title: Set Up the Core Test Harness and Testing Guidelines
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 11-setup-package-scaffolding-and-move-existing-cli.md
---

# Set Up the Core Test Harness and Testing Guidelines

## Summary

Give `@prodigy/core` the integration-first test harness the run-contract slices build on: vitest runs as two serial projects (`unit` / `integration`), shared test doubles live in `src/__integration__/helpers.ts`, `@effect/vitest` is added to devDependencies, and the conventions are recorded in `specs/guides/testing-core-integration.md`. This is a test seam, not a contract.

## Context / Current State

`packages/core` is a package scaffold whose vitest config is a single project with no `__integration__` split and no `@effect/vitest` devDependency. `@prodigy/cli` already has the target pattern — `packages/cli/vitest.config.ts` runs `unit` (excludes `src/__integration__/**`) and `integration` (only it), serial; doubles live in `packages/cli/src/__integration__/helpers.ts`. Mirror that pattern.

## Goals

- `bun run test --run` in `packages/core` reports both a `unit` and an `integration` project, non-concurrent.
- A home for shared doubles so slices 13–19 extend helpers instead of re-inventing them.
- A written convention: integration-first through the public API with real Layers; unit tests only for hard-to-reach pure logic.

## Non-Goals

- No run-contract types, `SessionStore`, model loop, or errors (slices 13+).
- No provider adapters in core; a mock OpenAI HTTP server belongs to `@prodigy/cli` (see the "Test-double boundaries" section of the guide).

## Design Constraints

- Core is runtime-neutral: `src` imports no Bun/Node built-ins. Tests may install runtime Layers (e.g. `BunServices`) only where a test needs them.
- Tests must use `@effect/vitest`'s `it.effect`/`layer`/`expect`; plain `it` on an Effect body silently never runs.

## Seams, Boundaries, and Adapters

The test seam is real Layers, never module mocks. This ticket establishes only the generic utilities; the doubles arrive with their slices:

- `makeTempDirectory`-style helper (scoped temp dirs) — generic.
- A `BunCrypto.layer` install convention for tests: `@effect/platform-bun` is added to core's devDependencies (`catalog:`), so tests needing real randomness (`SessionId`/`RunId` from slices 13/14) provide the `Crypto` requirement with the real Bun-backed layer via `Layer.merge`. Id allocation is real — tests assert shape/format/uniqueness, never exact values. Core `src` stays runtime-neutral; the platform dependency is dev-only.
- Layer merge/provide conventions shown by the smoke test.

Later slices add: test-double `LanguageModel` (14), scripted toolkit (15), scripted `HumanInteraction` (18), session factory (13).

## Files to Add / Change / Delete

- Change `packages/core/vitest.config.ts` — two serial projects (`unit`, `integration`), mirroring the CLI.
- Change `packages/core/package.json` — add `@effect/vitest` and `@effect/platform-bun` (both `catalog:`) to devDependencies.
- Change `packages/core/tsconfig.json` — include vitest types as needed for `@effect/vitest`.
- Add `packages/core/src/__integration__/helpers.ts` — generic utilities (temp dirs, layer-composition helper).
- Add `packages/core/src/__integration__/harness.integration.test.ts` — smoke test proving both suites run and `it.effect` actually executes.
- Add `specs/guides/testing-core-integration.md` — the conventions doc (delivered here).
- Delete none.

## RGR TDD Test Plan

Vertical red-green-refactor slices, integration-first:

- R1: **Smoke** — write a red `harness.integration.test.ts` that composes a trivial real Layer (a helper or `BunServices`) and asserts an `it.effect` body ran. Minimal implementation: vitest projects config + devDependencies. Green when `bun run test --run` reports both suites and the assertion passed.
- R2: **Helpers** — red test using `makeTempDirectory` (create + scoped cleanup). Implement the helper. Green when the helper round-trips.
- R3: **Documentation** — the guide exists and its rules are reflected by the harness layout (no red test; acceptance by review).

## Risks and Open Questions

- `@effect/vitest` version must match the repo catalog (`catalog:` entry) so core and CLI share one Effect install.
- Whether the smoke test needs a runtime Layer (Bun) in a runtime-neutral package — keep it minimal and scoped; core `src` stays Bun-free, and `@effect/platform-bun` is a devDependency used only by tests (id allocation in slices 13/14).

## Acceptance criteria

- [ ] `@effect/vitest` and `@effect/platform-bun` (both via `catalog:`) are added to `@prodigy/core`'s devDependencies.
- [ ] `packages/core` vitest config runs two serial projects — `unit` (`src/*.test.ts`, excluding `src/__integration__/**`) and `integration` (`src/__integration__/**/*.test.ts`) — so `bun run test --run` reports both suites.
- [ ] Generic integration helpers exist (temp directories, layer-composition convention) and a smoke integration test proves both suites run.
- [ ] A testing guide at `specs/guides/testing-core-integration.md` documents the integration-first rule, the unit-tests-only-for-hard-to-cover-cases rule, the `it.effect`/`layer`/`expect` conventions, and the "never `bun test`" rule.
- [ ] `bun run test --run` in `packages/core` passes with both projects reported.

## Blocked by

11-setup-package-scaffolding-and-move-existing-cli.md — must complete first.
