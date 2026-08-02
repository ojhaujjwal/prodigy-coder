---
title: Define the Typed AgentError Union and ModelError Mapping
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 14-implement-the-lazy-prodigyagent-run.md
---

# Define the Typed AgentError Union and ModelError Mapping

## Summary

Failures surface as concrete, tagged members of the exported `AgentError` union rather than a generic runtime wrapper: invalid requests are rejected as `InvalidRunRequest`, missing sessions as `SessionNotFound`, session-storage failures as `SessionStorageError`, model failures as `ModelError`, and tool-system failures as `ToolSystemError`. `ModelError` maps provider errors onto the provider-neutral reason union with retryability derived from the concrete reason. `RemoteError` is reserved for future remote transports, not yet exercised.

## Context / Current State

Slice 14 surfaces `SessionNotFound` ad hoc; the CLI today emits an `error` `OutputEvent` string instead of a typed failure. Ticket 01 fixes the failure model: `AgentError` is a compile-time union of concrete tagged errors (with a discriminated `reason` where there are subcategories), never an extra runtime wrapper. `ModelError.reason` uses recovery-oriented, provider-neutral categories.

## Goals

- The complete `AgentError` union as a public core type.
- Every run failure fails the stream with the specific typed error — never a wrapper or a string.
- `ModelError` maps provider reasons through the neutral union and derives retryability from it.

## Non-Goals

- Run-level retry policy (callers / `HarnessLoop`, ticket 06) — the core exposes typed reasons, not retry orchestration.
- `RemoteError` transport implementation (deferred until ticket 05 defines a wire protocol).
- Cancellation as an error: interruption never becomes an `AgentError`.

## Invariants

- `AgentError` members are discriminated-tagged concrete errors; `ModelError` owns a `reason` union.
- Retryability is derived from `ModelError.reason`, not stored as an unrelated boolean.
- A failed run does not emit `run-ended`; it fails the stream with exactly one typed error.
- Provider-specific error details are mapped into the neutral reasons, not passed through raw.

## Design Constraints

- Cohesive error families use the wrapper-plus-`reason` pattern from ticket 02's amendment (as the CLI's `SessionNotFound`/`SessionStorageError` already do).
- Each `AgentError` member is implemented as a `Schema.TaggedErrorClass` data class (pinned `effect-smol` LLMS guidance) so the discriminated `_tag` is a runtime value usable with `Effect.catchTag`/`catchTags`; the type-union listings in this ticket describe the contract, not the runtime representation.
- `SessionStore` failures (slice 13) are mapped at the agent boundary: `SessionNotFound` reason → `AgentError.SessionNotFound`; read/decode/write/encode/conflict → `AgentError.SessionStorageError`.

## Types, Interfaces, and APIs

```ts
type AgentError =
  | InvalidRunRequest
  | SessionNotFound
  | SessionStorageError
  | ModelError
  | ToolSystemError
  | RemoteError

type InvalidRunRequest = { readonly _tag: "InvalidRunRequest"; readonly reason: InvalidRunReason }
// InvalidRunReason = empty-prompt | missing-prompt | invalid-max-turns | out-of-bounds-override (slice 17)

type SessionNotFound = { readonly _tag: "SessionNotFound"; readonly sessionId: SessionId }
type SessionStorageError = { readonly _tag: "SessionStorageError"; readonly reason: SessionStorageReason }
// SessionStorageReason = conflict | encode | write | read | decode   (mapped from SessionStore families)

type ModelError = { readonly _tag: "ModelError"; readonly reason: ModelReason }
type ModelReason =
  | "transport" | "authentication" | "rate-limit" | "quota"
  | "invalid-request" | "content-policy" | "invalid-output" | "provider"

type ToolSystemError = { readonly _tag: "ToolSystemError"; readonly reason: ToolSystemReason }   // from slice 15
type RemoteError = { readonly _tag: "RemoteError"; readonly reason: RemoteReason }               // reserved

// retryability derived from reason, e.g.:
//   transport | rate-limit | quota | provider -> retryable
//   authentication | invalid-request | content-policy | invalid-output -> not retryable
```

## Seams, Boundaries, and Adapters

- **Model seam**: `LanguageModel`/Effect AI error types are translated at the agent boundary into `ModelError` + a neutral `ModelReason`. The mapping function is the sole place provider errors cross into core.
- **Session seam**: `SessionLookupError`/`SessionPersistenceError` (slice 13) map into `SessionNotFound` / `SessionStorageError`.
- Provider-specific retry hints are discarded; only the neutral reason survives.

## Call Stacks and Data Flow

```txt
InvalidRunRequest: run({ prompt: "" })
  -> validate request                    -> fail stream with InvalidRunRequest{ reason: empty-prompt }

SessionNotFound: run({ sessionId: missing })
  -> SessionStore.load(id) -> SessionLookupError{ reason: SessionNotFound }
  -> map -> AgentError.SessionNotFound{ sessionId } -> fail stream

SessionStorageError: SessionStore.save(checkpoint)
  -> SessionPersistenceError{ reason: Conflict | Encode | Write }
  -> map -> AgentError.SessionStorageError{ reason } -> fail stream (no run-ended)

ModelError: LanguageModel.streamText(...)
  -> provider/model failure -> map provider error -> ModelError{ reason }
  -> fail stream; callers derive retryability from reason

ToolSystemError: (from slice 15) toolkit-level failure -> fail stream
```

## Files to Add / Change / Delete

- Add `packages/core/src/agent/agent-error.ts` — the `AgentError` union and each concrete tagged error.
- Add `packages/core/src/agent/model-error.ts` — `ModelReason`, `ModelError`, the provider→reason mapping function, and `isRetryable(reason)`.
- Add `packages/core/src/agent/session-error-projection.ts` (or fold into `agent-error.ts`) — `SessionStore` error → `AgentError` projection.
- Change `packages/core/src/agent/prodigy-agent.ts` — fail the stream through the typed union instead of ad hoc errors.
- Add `packages/core/src/agent/__integration__/errors.integration.test.ts` and `packages/core/src/agent/model-error.unit.test.ts` — the RGR slices below.
- Delete none.

## RGR TDD Test Plan

Vertical red-green-refactor slices, integration-first through the public stream:

- R1: **InvalidRunRequest** — red: an empty (or missing) prompt fails the stream with `InvalidRunRequest` before any session work. Implement request validation.
- R2: **SessionNotFound projection** — red: `run({ sessionId: missing })` fails with the typed `SessionNotFound` carrying the id. Implement the `SessionStore`→`AgentError` projection.
- R3: **SessionStorageError** — red: a `save` conflict/encode/write failure during a run fails the stream with `SessionStorageError`. Implement the persistence-family projection.
- R4: **ModelError mapping** — red: a test-double `LanguageModel` that fails with a provider-style error fails the stream with `ModelError` + a neutral reason. Implement the mapping function.
- R5 (unit): **reason → retryability** — the pure `isRetryable(reason)` table per reason (hard to reach distinctly through the stream).
- R6 (unit): **provider → reason mapping** — pure mapping per provider error category, before it crosses the seam.

## Risks and Open Questions

- Exact `ModelReason` vocabulary is fixed by ticket 01; the mapping from Effect AI's error shapes to those reasons needs confirmation against the catalog version.
- Whether `SessionStorageError` should carry operation-safe detail beyond `reason` — follow ticket 02's "safe context" guidance.

## Acceptance criteria

- [ ] `AgentError` is an exported union of concrete tagged errors with the ticket-01 shape.
- [ ] `ModelError` owns the provider-neutral reason union and derives retryability from the reason; provider-specific errors are mapped, not passed through raw.
- [ ] Invalid `RunRequest` inputs are rejected as `InvalidRunRequest`.
- [ ] Session-storage failures during a run surface as `SessionStorageError`.
- [ ] Integration tests assert the stream fails with each specific typed error when driven end-to-end (missing session, invalid request, model failure, storage failure).
- [ ] Unit tests cover the hard-to-reach pure mapping of provider errors → `ModelError.reason` → retryability, per the testing guide `specs/guides/testing-core-integration.md`.
- [ ] `bun run test --run` in `packages/core` passes.

## Blocked by

14-implement-the-lazy-prodigyagent-run.md — must complete first.
