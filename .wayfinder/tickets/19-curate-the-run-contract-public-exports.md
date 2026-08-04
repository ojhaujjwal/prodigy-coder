---
title: Curate the Run-Contract Public Exports
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 14-implement-the-lazy-prodigyagent-run.md
  - 15-implement-tool-call-and-tool-result-events.md
  - 16-define-the-typed-agenterror-union-and-modelerror-mapping.md
  - 17-implement-maxturns-override-and-stopped-result.md
  - 18-implement-interaction-requested-and-humaninteraction.md
---

# Curate the Run-Contract Public Exports

## Summary

`@prodigy/core`'s root entrypoint re-exports the stable run-contract API: `ProdigyAgent`, `RunRequest`, `AgentEvent`, `AgentResult`, `AgentFinishReason`, `AgentError`, and the session types + `SessionStore` (with the in-memory adapter + file-system adapter). The entrypoint stays import-safe — no Bun/Node built-ins and no process startup on import — so the CLI, the future Ralph harness, and remote consumers can depend on the public API. Implementation helpers remain unexported.

## Context / Current State

`packages/core/src/index.ts` is the scaffold placeholder exporting only `packageName` and a `CorePackage` type; slices 13–18 have been adding `export`ed contracts in their modules. Ticket 08 fixes the public boundary: each package has a curated root export; internal source paths and wildcard exports are not public API. This slice curates what the root `index.ts` re-exports and proves import safety.

## Goals

- A curated root `index.ts` covering the stable run-contract contracts.
- Importing `@prodigy/core` performs no effects and triggers no process startup.
- The package passes `bun run ci` (lint, typecheck, both test suites).

## Non-Goals

- Built-in tool definitions, toolkit/profile composition, capability adapters beyond the memory `SessionStore`, and provider constructors — not promoted to root in this slice (ticket 08 keeps them out until a later ticket promotes them).
- The CLI rebuild onto core (CLI compatibility ticket).
- Publishing/versioning automation.

## Invariants

- Root exports are explicit and curated; wildcard re-exports of internal modules are not public API.
- Import-time side-effect freedom: no provider construction, no runtime start, no platform service access at module scope.
- Consumers import shared contracts from `@prodigy/core` only; the root does not re-export CLI or harness symbols.

## Design Constraints

- Runtime-neutral module graph at import time (ticket 08): `index.ts` must not pull Bun/Node/platform modules.
- Test seam: an import test from outside the package proves the public surface resolves and type-checks.

## Types, Interfaces, and APIs

```ts
// packages/core/src/index.ts
export { ProdigyAgent } from "./agent/prodigy-agent.ts"
export type { RunRequest, RunId } from "./agent/run-request.ts"
export type { AgentEvent, AgentResult, AgentFinishReason } from "./agent/agent-event.ts"
export type { AgentError, ModelError } from "./agent/agent-error.ts"
export { SessionStore } from "./capabilities/session-store.ts"
export type { SessionError, SessionLookupError, SessionPersistenceError } from "./capabilities/session-store.ts"
export { MemorySessionStore, memorySessionStoreLayer } from "./capabilities/memory-session-store.ts"
export type { Session, SessionId, SessionRevision, SessionSnapshot, SessionCheckpoint } from "./capabilities/session.ts"
```

Branded types are exported as **types only** — never the brand schemas or the internal generators (`generateSessionId`, `generateRunId`). Construction stays inside the owning authorities (store / run loop); consumers receive branded values and name the types (see `specs/guides/branded-types.md`).

Unexported: error-projection helpers, finish-reason mapping internals, all `__integration__` helpers, and `HumanInteraction`/its error type (not part of the v1 run-contract surface; consumers install their own adapter without naming its contract).

## Seams, Boundaries, and Adapters

- **Public boundary**: `packages/core/src/index.ts` is the only documented import surface; subpath imports are not part of the v1 contract.
- The in-memory `SessionStore` adapter and its Layer are exported as the usable local adapter; the file adapter is deferred.
- Branded types (`SessionId`, `RunId`, `SessionRevision`) surface as types only — schemas and generators stay internal.

## Call Stacks and Data Flow

```txt
external consumer (CLI / Ralph / test)
  import { ProdigyAgent, ... } from "@prodigy/core"
    -> module evaluation: type-only + service-tag definitions only
    -> no effects, no platform service access, no runtime start
  compose Layers (provider, session store, toolkit) -> consume ProdigyAgent.run stream
```

## Files to Add / Change / Delete

- Change `packages/core/src/index.ts` — curated re-exports replacing the scaffold placeholder.
- Change `packages/core/src/index.test.ts` — replace the scaffold test with the external-import contract test.
- Add `packages/core/src/__integration__/public-exports.integration.test.ts` — an out-of-package consumer test (type-checks + resolves the curated surface).
- Delete the scaffold `CorePackage`/`packageName` shape once consumers no longer reference it (only the scaffold test does).
- No config/migration files.

## RGR TDD Test Plan

Vertical red-green-refactor slices:

- R1: **curated surface resolves** — red: an external import test asserts the run-contract symbols are importable from the package root and no longer the scaffold placeholder. Minimal implementation: re-export the slice-13–18 contracts from `index.ts`.
- R2: **import-time safety** — red: a test asserts importing `@prodigy/core` performs no effects and triggers no process startup. Implement by keeping `index.ts` effect-free (no `BunRuntime`, no provider construction).
- R3: **internal helpers hidden** — red: a type-level assertion that implementation helpers are not importable from the root (compile-time check). Curate exports to exclude them.

## Risks and Open Questions

- `RunId` is resolved as **exported**: ticket 01 exposes it in `run-started`, so callers need to name it.
- `packageName`/`CorePackage` scaffold removal — confirm no other consumer references it.
- `HumanInteraction` stays unexported from the root: consumers install their own adapter, so core need not commit its contract in v1. Revisit if a first-party adapter ships in core.

## Acceptance criteria

- [ ] The `@prodigy/core` root export is curated: the stable run-contract contracts are importable from the package root; implementation helpers are not exported.
- [ ] Importing `@prodigy/core` performs no effects and triggers no process startup.
- [ ] An import test from outside the package confirms the public surface type-checks and resolves.
- [ ] The `@prodigy/core` package passes `bun run ci` (lint, typecheck, and both the unit and integration suites, per the testing guide `specs/guides/testing-core-integration.md`).

## Blocked by

14-implement-the-lazy-prodigyagent-run.md, 15-implement-tool-call-and-tool-result-events.md, 16-define-the-typed-agenterror-union-and-modelerror-mapping.md, 17-implement-maxturns-override-and-stopped-result.md, 18-implement-interaction-requested-and-humaninteraction.md — all must complete first.
