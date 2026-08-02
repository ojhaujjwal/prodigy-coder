---
title: Implement Tool-Call and Tool-Result Events
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 14-implement-the-lazy-prodigyagent-run.md
---

# Implement Tool-Call and Tool-Result Events

## Summary

When the model requests tools, the run emits `tool-call` (JSON-safe input), executes the handler through the caller-provided toolkit context, and emits the matching `tool-result` with a tagged success/failure outcome. A run spans multiple turns until the model finishes; each tool call precedes its result. Ordinary tool failures and approval denials stay model-visible failed tool results so the run recovers, while tool-system failures (unknown-tool routing, toolkit misconfiguration, serialization) fail the run as `ToolSystemError`.

## Context / Current State

Slice 14 emits `run-started`/`turn-started`/`text-delta`/`run-ended` but does not hand the model a toolkit. The CLI's `runAgent` (`packages/cli/src/agent.ts`) is the reference: it passes `AgenticToolkit` to `LanguageModel.streamText`, Effect AI executes tool handlers, and the agent maps `tool-call`/`tool-result` response parts to events, continuing the loop while tool calls occur. Ticket 03 fixes the toolkit seam: Effect AI `Toolkit` values and handler Layers, composed at runtime construction. This slice wires tools into the loop and projects their events.

## Goals

- `tool-call` and `tool-result` events with JSON-safe payloads and tagged outcomes.
- Multi-turn loop: tool-calling turns continue until the model finishes.
- Recoverable model-visible failures vs run-failing tool-system failures, distinguished by type.

## Non-Goals

- The typed toolkit/profile composition surface (ticket 03's `AgentProfile`/`makeProdigyAgentLayer`) — that lands with the capability slice; this slice drives a concrete toolkit already in context.
- Built-in tool handlers and their per-tool failure schemas (tickets 09 follow-up).
- Approval/interaction projection — slice 18.

## Invariants

- Each `tool-call` is followed by a matching `tool-result` (same `callId`); no result before its call.
- `tool-call`/`tool-result` payloads are JSON-safe (`JsonValue`); no function refs, Dates, or provider types leak.
- A failed tool result is an event, not a stream failure.
- A tool-system failure fails the stream with `ToolSystemError` (no further events).
- The turn loop terminates on model finish; a run that only makes tool calls does not end.

## Design Constraints

- Tool execution uses Effect AI's native execution: handlers are acquired through the toolkit handler Layer (ticket 03), not a bespoke registry.
- The core does not know tool names or schemas; it projects generic call/result parts.
- `ToolOutcome` tags success vs failure; the model-visible projection is derived from the tagged outcome.

## Types, Interfaces, and APIs

```ts
type JsonValue = unknown  // JSON-safe, per ticket 01

type ToolOutcome =
  | { readonly _tag: "Success"; readonly output: JsonValue }
  | { readonly _tag: "Failed"; readonly error: string }   // model-visible, recoverable

type AgentEvent = // extended
  | { readonly type: "tool-call"; readonly callId: string; readonly toolName: string; readonly input: JsonValue }
  | { readonly type: "tool-result"; readonly callId: string; readonly toolName: string; readonly outcome: ToolOutcome }
  // + the slice-14 events

type ToolSystemError = { readonly _tag: "ToolSystemError"; readonly reason: ToolSystemReason }
// ToolSystemReason = unknown-tool routing | toolkit misconfiguration | protocol/serialization
```

Handler execution signature (Effect AI `Tool` handler context): a handler takes `(input, context)` and returns `Effect<result, handlerError>`; the loop maps success → `Success`, ordinary handler failure → `Failed`, and toolkit-level failures (unknown tool, missing handler, unserializable output) → `ToolSystemError`.

## Seams, Boundaries, and Adapters

- **Toolkit seam**: the `Toolkit` + handler `Layer` (ticket 03) supplied to `LanguageModel.streamText`; the core loop remains toolkit-agnostic.
- **Failure projection**: handler failures become model-visible `Failed` results; orchestration failures (unknown tool, misconfigured handlers) become `ToolSystemError`. Denials arrive later as `Failed` (slice 18).
- Test seam: a scripted test-toolkit layer helper (records calls, scriptable outcomes) replaces the CLI's `createStubToolkit` pattern inside core.

## Call Stacks and Data Flow

```txt
turn loop (from slice 14)
  LanguageModel.streamText({ prompt, toolkit })          // toolkit now attached
    -> Response part "tool-call" { id, name, params }
       emit tool-call { callId: id, toolName: name, input: params }
       execute handler via toolkit handler Layer
         success                      -> ToolOutcome Success   -> emit tool-result
         handler failure              -> ToolOutcome Failed    -> emit tool-result (recoverable)
         toolkit failure (unknown tool / misconfig / serialization)
                                      -> AgentError ToolSystemError -> stream fails
    -> Response part "finish"        -> finishReason mapping; break
  append assistant + tool exchange to transcript
  SessionStore.save(turn checkpoint)                    // ticket 04 cadence
  continue while model requested tools; terminate on finish
```

Current vs proposed: today the CLI executes handlers through `AgenticToolkitLayer` + `makeToolkitLayer` (approval-wrapped) and suppresses preliminary tool results. Core projects the tagged `ToolOutcome`; approval wrapping becomes slice 18's interaction projection.

## Files to Add / Change / Delete

- Change `packages/core/src/agent/agent-event.ts` — add `tool-call`/`tool-result` variants and `ToolOutcome`.
- Change `packages/core/src/agent/prodigy-agent.ts` — attach toolkit to `streamText`, execute handlers, project tool events, add `ToolSystemError` failure branch.
- Add `packages/core/src/agent/tool-outcome.ts` (or fold into `agent-event.ts`) — `ToolOutcome` and projection helpers.
- Add `packages/core/src/agent/__integration__/helpers.ts` additions — scripted test-toolkit layer helper.
- Add `packages/core/src/agent/__integration__/tools.integration.test.ts` — the RGR slices below.
- Delete none.

## RGR TDD Test Plan

Vertical red-green-refactor slices, integration-first through the public stream with real Layers (memory `SessionStore` + test-double `LanguageModel` + scripted toolkit):

- R1: **single tool round-trip** — red: a model that requests one tool produces `tool-call` then the matching `tool-result` (same `callId`, `Success`), then the next turn finishes. Implement part projection + handler execution + loop continuation.
- R2: **recoverable failure** — red: a handler that fails yields `tool-result` with `Failed` and the run continues (no stream failure).
- R3: **tool-system failure** — red: an unknown tool (or misconfigured toolkit) fails the stream with `ToolSystemError` and emits no further events.
- R4: **JSON-safe payloads** — red: tool inputs/outputs carry only JSON-safe values through the events (no provider types leak).
- R5 (unit): **failure tagging** — the `Success`/`Failed`/`ToolSystemError` discrimination is reachable via integration (R2/R3); keep a unit test only for pure projection helpers that are impractical through the stream, per the guide.

## Risks and Open Questions

- Whether Effect AI's native `streamText` executes handlers inline (emitting `tool-result` parts) or whether the loop must call handlers explicitly — match the CLI's observed behavior and the `@effect/ai` version in the catalog.
- `ToolSystemError` detection: unknown-tool routing is only discoverable when Effect AI reports it; confirm the failure surface at the version in use.

## Acceptance criteria

- [ ] `tool-call` and `tool-result` events carry JSON-safe payloads and a tagged success/failure outcome per ticket 01.
- [ ] A scripted test toolkit/handler layer helper (recording calls, scriptable outcomes) is added to the integration helpers.
- [ ] Integration tests drive the run end-to-end and assert: a model that requests a tool produces `tool-call` then the matching `tool-result` and continues to a further turn; a failed tool result does not fail the run; a tool-system failure (e.g. unknown tool) fails the run with `ToolSystemError`.
- [ ] Unit tests are limited to hard-to-reach branches (e.g. tool-system failure tagging) per the testing guide `specs/guides/testing-core-integration.md`.
- [ ] `bun run test --run` in `packages/core` passes.

## Blocked by

14-implement-the-lazy-prodigyagent-run.md — must complete first.
