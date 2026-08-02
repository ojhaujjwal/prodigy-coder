---
title: Implement the Lazy ProdigyAgent Run
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 13-define-core-sessionstore-port-and-in-memory-adapter.md
---

# Implement the Lazy ProdigyAgent Run

## Summary

The canonical `ProdigyAgent` service: `run(RunRequest)` returns a lazy `Stream<AgentEvent, AgentError>`. Consuming the stream resolves session identity (fresh session when no `sessionId`; typed `SessionNotFound` when a supplied id is missing), generates a `RunId`, and emits the causal `run-started` → `turn-started` → `text-delta`… → `run-ended` sequence against a caller-provided `LanguageModel`. Successful runs emit exactly one `run-ended` carrying `Finished { sessionId, turns, finishReason }` and complete. Consumer cancellation interrupts without `run-ended` and is not an `AgentError`. No tools yet.

## Context / Current State

The CLI's `runAgent` (`packages/cli/src/agent.ts`) is the behavioral reference: it calls `LanguageModel.streamText`, maps response parts to `OutputEvent`s, buffers text per turn, and mutates the session in place with a single post-hoc save. Core replaces this with a lazy service stream that owns session resolution, checkpointing (ticket 04), event projection, and typed failures. Reference ticket: `01-define-the-prodigyagent-run-contract.md`.

## Goals

- `ProdigyAgent.run` is lazy, composable, and safe: no effects until the stream is consumed; each consumption is a fresh run with a fresh `RunId`.
- Session identity is explicit: new session on omit, `SessionNotFound` on missing id — never silent replacement.
- One `run-ended` (`Finished`) per successful run, with agent-owned `finishReason`.
- Interruption is Effect interruption: no `run-ended`, no `AgentError`.

## Non-Goals

- Tools (`tool-call`/`tool-result`) — slice 15.
- The full `AgentError` union and `ModelError` mapping — slice 16.
- `maxTurns`/`Stopped` — slice 17.
- `interaction-requested`/`HumanInteraction` — slice 18.
- Public root exports — slice 19.
- Provider adapters; core sees only the `LanguageModel` contract.

## Invariants

- `run-started` is the first event and carries the resolved `SessionId` + generated `RunId`.
- Causal order: `run-started` → `turn-started` → `text-delta`… → `run-ended`; nothing follows `run-ended`.
- Successful runs emit exactly one `run-ended` and then complete normally.
- A supplied `sessionId` must resolve; `SessionNotFound` never becomes a new session.
- Cancellation/interruption terminates without `run-ended` and without an `AgentError`.
- Checkpoints (ticket 04): prompt checkpoint before the first model request; final checkpoint before `run-ended`; `run-ended` only after the final save succeeds.

## Design Constraints

- Effect API is canonical; the service is a `Context.Service` returning a `Stream` — no `AgentRun` handle type is public (ticket 01).
- Core depends only on the provider-neutral `LanguageModel`; the `RunId` comes from the same `Crypto` seam the memory store uses for `SessionId` (slice 13): generated in the run loop via `Crypto.randomUUIDv7`. `RunId` follows the shared brand convention (`specs/guides/branded-types.md`): `Schema.brand`, schema private, type exported, no public `.make`.
- The `ProdigyAgent` module exposes a dependency-preserving `layerNoDeps` whose requirements are `SessionStore`, `LanguageModel`, the toolkit handler authorities, `Crypto`, and the optional `HumanInteraction` (slice 18). Ticket 03's generic `makeProdigyAgentLayer` composes that into the ready layer at the composition root — the module never constructs a concrete toolkit or provider.

## Types, Interfaces, and APIs

```ts
const RunId = Schema.String.pipe(
  Schema.isUUID(7),          // strict UUIDv7
  Schema.brand("RunId")
)                              // schema private, type exported
type RunId = Schema.Schema.Type<typeof RunId>
type RunRequest = { readonly prompt: string; readonly sessionId?: SessionId; readonly maxTurns?: PositiveInt }

class ProdigyAgent extends Context.Service<ProdigyAgent, {
  readonly run: (request: RunRequest) => Stream.Stream<AgentEvent, AgentError>
}>()("prodigy/ProdigyAgent") {}

type AgentEvent =
  | { readonly type: "run-started"; readonly runId: RunId; readonly sessionId: SessionId }
  | { readonly type: "turn-started"; readonly turn: number }
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "run-ended"; readonly result: AgentResult }
  // tool-call / tool-result / interaction-requested arrive in slices 15 and 18

type AgentResult = { readonly _tag: "Finished"; readonly sessionId: SessionId; readonly turns: number; readonly finishReason: AgentFinishReason }
// Stopped variant arrives in slice 17

type AgentFinishReason =  // Prodigy-owned projection of provider finish values (recovery-relevant)
  | "stop" | "length" | "content-filter" | "tool-calls" | "error" | "pause" | "other" | "unknown"
```

Dependencies of the implementation module: `SessionStore` (slice 13), `LanguageModel` (caller-provided, or a test-double), and an id source. The loop projects Effect AI `Response` parts (`text-delta`, `finish`, later `tool-call`/`tool-result`) into `AgentEvent`s; `finish` maps through `AgentFinishReason`.

## Seams, Boundaries, and Adapters

- **`LanguageModel`** (from `effect/unstable/ai`) is the model seam. Core never imports a provider. Tests install the test-double built with `LanguageModel.make` over scripted `Response.StreamPartEncoded` parts — a contract-boundary double, not a mock OpenAI HTTP server (those belong to `@prodigy/cli`).
- **`SessionStore`** (slice 13) is the session seam; the agent depends only on the port.
- **`RunId` generation**: `Crypto.randomUUIDv7` yielded from context in the run loop (required dependency), so freshness is real randomness — tests assert shape/format/uniqueness, never exact values. No injectable id source, no scripted ids.
- Provider response parts, formatting, usage, and debug events stay behind adapters — never part of the event stream.

## Call Stacks and Data Flow

```txt
caller: consume Stream<AgentEvent, AgentError>
  run({ prompt, sessionId? })
    sessionId provided?  -> SessionStore.load(id)         (SessionNotFound -> typed stream failure)
    else                 -> SessionStore.create()
    generate RunId (Crypto.randomUUIDv7)
    emit run-started { runId, sessionId }
    SessionStore.save(prompt checkpoint)                  // before first model request
    turn loop (turn = 1..):
      emit turn-started { turn }
      prompt = transcript + user prompt
      LanguageModel.streamText({ prompt })                // seam; test-double in tests
        -> Response parts
        -> project: text-delta -> emit text-delta
                     finish    -> finishReason = mapAgentFinishReason(part.reason); break
      append assistant text to transcript
      SessionStore.save(turn checkpoint)                  // after completed exchange
    emit run-ended { result: Finished { sessionId, turns, finishReason } }
    complete normally
  consumer cancellation -> Effect interruption -> finalizers run; no run-ended
```

Current (CLI) vs proposed: today `runAgent` buffers all events into an array and the caller renders after; core streams each event. A CLI consumer can `runCollect` to preserve batch behavior (CLI rebuild is separate).

## Files to Add / Change / Delete

- Add `packages/core/src/agent/agent-event.ts` — `AgentEvent` union, `AgentResult`, `AgentFinishReason`, mapping function for finish reasons.
- Add `packages/core/src/agent/run-request.ts` — `RunRequest`, plus the module-private `RunId` brand schema (type exported) and the internal `generateRunId` (`Crypto.randomUUIDv7`).
- Add `packages/core/src/agent/prodigy-agent.ts` — the `ProdigyAgent` service, the run-stream implementation (session resolution, run loop, event projection, checkpointing).
- Add `packages/core/src/agent/prodigy-agent.test-helpers.ts` (or extend `src/__integration__/helpers.ts`) — the test-double `LanguageModel` layer helper.
- Add `packages/core/src/agent/__integration__/prodigy-agent.integration.test.ts` — the RGR slices below.
- Change `packages/core/src/capabilities/*` — none (consume the port). Delete none.

## RGR TDD Test Plan

Vertical red-green-refactor slices, integration-first through the public stream with real Layers (memory `SessionStore` + test-double `LanguageModel`):

- R1: **run-started + Fresh session** — red: `run({ prompt })` emits `run-started` first with a `RunId` and a resolved `SessionId`, then `run-ended`/`Finished`. Minimal implementation: service tag, stream construction, session `create`, `run-started`, empty loop.
- R2: **text streaming + Finished** — red: a text-only model emits `turn-started` then `text-delta`s in order, and `run-ended` carries `turns` and a `finishReason` mapped from the model's finish part. Implement part projection + finish mapping.
- R3: **laziness + fresh RunId** — red: calling `run` performs no effects (no session is created before consumption), and each consumption yields a fresh `RunId`. Implement effect deferral and per-consumption `generateRunId`. Assert shape/format/uniqueness (UUIDv7) with the real `Crypto` layer — never exact values.
- R4: **SessionNotFound** — red: `run({ sessionId: missing })` fails the stream with the typed `SessionNotFound`, never a new session. Implement `load` resolution + error projection (minimal `AgentError` usage; full union is slice 16).
- R5: **interruption** — red: early consumer cancellation interrupts without `run-ended` and without an `AgentError`. Implement interruption-safe stream construction (finalizers only).
- R6 (unit): **finish → `AgentFinishReason`** — the pure mapping table per provider finish value (hard to reach distinctly through the stream).

## Risks and Open Questions

- Exact `AgentFinishReason` vocabulary: start from the provider finish reasons observed in the CLI (`stop|length|content-filter|tool-calls|error|pause|other|unknown`) and refine as a Prodigy-owned projection.
- Whether `turn-started` is emitted for turn 0 or 1 — ticket 01 shows `turn: number`; align with `Finished.turns` semantics in the same slice.
- Checkpoint cadence: R1–R6 need at least prompt + final checkpoint to honor ticket 04; full per-turn checkpointing may land here or in a follow-up within this slice.
- `RunId` follows the shared brand convention: `Schema.String.pipe(Schema.isUUID(7), Schema.brand("RunId"))`, schema private, type exported, constructed only via the internal `generateRunId` (`Crypto.randomUUIDv7`).

## Acceptance criteria

- [ ] `ProdigyAgent`, `RunRequest`, `AgentEvent`, `AgentResult`, and `AgentFinishReason` are exported types from core modules with the ticket-01 shapes.
- [ ] Calling `run` performs no effects; each consumption of the returned stream is a fresh run with a fresh `RunId`.
- [ ] A run with no `sessionId` creates a new session; a run with a missing `sessionId` fails with `SessionNotFound` and never falls back to a new session.
- [ ] A test-double `LanguageModel` layer helper is added to the integration helpers: a real conforming `LanguageModel` service (via `LanguageModel.make`) fed with scripted `Response.StreamPartEncoded` parts — a contract-boundary double, not a mock OpenAI HTTP server (those belong to `@prodigy/cli`).
- [ ] Integration tests drive `ProdigyAgent.run` end-to-end with real Layers and assert the causal event order, the `Finished` metadata, and that early consumer cancellation interrupts without `run-ended` or an `AgentError`.
- [ ] Unit tests cover only hard-to-reach pure logic such as the provider finish value → `AgentFinishReason` mapping, per the testing guide `specs/guides/testing-core-integration.md`.
- [ ] `bun run test --run` in `packages/core` passes.

## Blocked by

13-define-core-sessionstore-port-and-in-memory-adapter.md — must complete first.
