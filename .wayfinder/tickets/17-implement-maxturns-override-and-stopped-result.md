---
title: Implement maxTurns Override and the Stopped Result
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 14-implement-the-lazy-prodigyagent-run.md
---

# Implement maxTurns Override and the Stopped Result

## Summary

`maxTurns` becomes an optional per-run override within the configured profile's resource bounds. A run that exhausts its turn limit emits `run-ended` with `Stopped { sessionId, turns, reason: "max-turns", limit }` and completes normally — exhaustion is a terminal result, not an error. Out-of-bounds overrides are rejected as `InvalidRunRequest`.

## Context / Current State

The CLI treats turn exhaustion as an error event (`error: "Max turns exceeded"`, `packages/cli/src/agent.ts:177`). Ticket 01 makes it a normal terminal result: `AgentResult` is `Finished | Stopped`, and `Stopped.reason` is `"max-turns"` with the limit. Slice 14's loop already has a turn guard internally; this slice promotes it to a first-class, validated, per-run result.

## Goals

- `RunRequest.maxTurns` overrides the profile default when supplied.
- Turn exhaustion emits exactly one `run-ended` with `Stopped` and completes normally — no `AgentError`.
- Overrides outside the profile's validated resource bounds are rejected as `InvalidRunRequest`.

## Non-Goals

- The profile type itself (`AgentProfile.maxTurns`, ticket 03) — this slice assumes a profile default exists and consumes it.
- Other stop reasons (cancellation stays interruption; no other `Stopped` reasons in v1).

## Invariants

- `Stopped` is a terminal result carried by the single `run-ended`; the stream completes normally after it.
- Turn counting is consistent between `turn-started { turn }` and `Stopped.turns`/`Finished.turns`.
- A run stopped by the limit never emits an `AgentError` for the limit.
- `maxTurns` is validated (positive, within profile bounds) before any session or model work.

## Design Constraints

- Per-run overrides may adjust bounded execution policy only; the toolkit/prompt/provider composition stays profile-bound (ticket 03).
- `PositiveInt`-shaped input; validation yields `InvalidRunRequest` (slice 16) for out-of-bounds or malformed values.

## Types, Interfaces, and APIs

```ts
type RunRequest = { readonly prompt: string; readonly sessionId?: SessionId; readonly maxTurns?: PositiveInt }

type AgentResult = // extended
  | { readonly _tag: "Finished"; readonly sessionId: SessionId; readonly turns: number; readonly finishReason: AgentFinishReason }
  | { readonly _tag: "Stopped"; readonly sessionId: SessionId; readonly turns: number; readonly reason: "max-turns"; readonly limit: number }
```

Turn guard: `effectiveMaxTurns = request.maxTurns ?? profile.maxTurns`; when `turns >= effectiveMaxTurns` with no model finish, the loop emits `run-ended { Stopped }` and ends.

## Seams, Boundaries, and Adapters

- **Profile seam**: the effective limit is resolved against the profile default. Until the profile type lands (ticket 03's composition slice), a minimal in-memory profile value supplies the default so this behavior is testable.
- **Validation seam**: malformed/out-of-bounds overrides project into `InvalidRunRequest` via slice 16's reason union.

## Call Stacks and Data Flow

```txt
run({ prompt, maxTurns })
  -> validate maxTurns (positive, within profile bounds)
       invalid -> fail stream with InvalidRunRequest{ reason: invalid-max-turns | out-of-bounds-override }
  -> effectiveMaxTurns = request.maxTurns ?? profile.maxTurns
  -> session resolution + run-started (slice 14)
  -> turn loop (turns = 1..):
       if turns > effectiveMaxTurns:
         emit run-ended { result: Stopped { sessionId, turns, reason: "max-turns", limit } }
         complete normally (NO AgentError)
       turn-started { turn }; model call; finish -> Finished path (slice 14)
```

Current vs proposed: today the CLI appends an `error` event at exhaustion; core emits a normal `Stopped` terminal result that formatters/consumers render as "stopped at limit".

## Files to Add / Change / Delete

- Change `packages/core/src/agent/agent-event.ts` — add the `Stopped` variant to `AgentResult`.
- Change `packages/core/src/agent/run-request.ts` — `maxTurns?: PositiveInt`.
- Change `packages/core/src/agent/prodigy-agent.ts` — resolve the effective limit, validate the override, add the turn guard terminal branch.
- Change `packages/core/src/agent/agent-error.ts` — `InvalidRunRequest` reasons for invalid/out-of-bounds `maxTurns`.
- Add `packages/core/src/agent/__integration__/max-turns.integration.test.ts` — the RGR slices below.
- Delete none.

## RGR TDD Test Plan

Vertical red-green-refactor slices, integration-first through the public stream with a test-double `LanguageModel` that never finishes:

- R1: **override honored** — red: `run({ prompt, maxTurns: 2 })` emits `turn-started` twice, then exactly one `run-ended` with `Stopped { reason: "max-turns", limit: 2 }`, and completes normally. Implement the effective-limit resolution and the guard terminal branch.
- R2: **profile default** — red: with no `maxTurns` in the request, the profile default governs. Implement `request.maxTurns ?? profile.maxTurns`.
- R3: **invalid override** — red: a non-positive or out-of-bounds `maxTurns` fails the stream with `InvalidRunRequest` before any session work. Implement validation + reason projection.
- R4: **no AgentError on stop** — covered by R1's completion assertion; keep as a distinct assertion that the stop produces no typed failure.

## Risks and Open Questions

- `Stopped.turns` semantics vs the `turn-started` numbering (same convention as slice 14) — fix the convention once here.
- Whether the guard checks before or after emitting `turn-started` for the exceeding turn — pick one and make `Stopped.turns` agree.

## Acceptance criteria

- [ ] `RunRequest.maxTurns` overrides the profile default when supplied.
- [ ] An override outside the profile's validated resource bounds is rejected as `InvalidRunRequest`.
- [ ] A run that reaches the limit emits exactly one `run-ended` with `Stopped` (`reason: "max-turns"`) and completes normally; no `AgentError`.
- [ ] Integration tests drive the run end-to-end with a test-double `LanguageModel` that never finishes and assert the `Stopped` result, plus the invalid-override rejection through the public API.
- [ ] Unit tests are limited to hard-to-reach pure branches (e.g. override bounds validation) per the testing guide `specs/guides/testing-core-integration.md`.
- [ ] `bun run test --run` in `packages/core` passes.

## Blocked by

14-implement-the-lazy-prodigyagent-run.md — must complete first.
