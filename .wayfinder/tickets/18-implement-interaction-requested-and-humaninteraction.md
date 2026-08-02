---
title: Implement interaction-requested and the HumanInteraction Capability
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 15-implement-tool-call-and-tool-result-events.md
---

# Implement interaction-requested and the HumanInteraction Capability

## Summary

Human approval and questions are the `HumanInteraction` capability, selected at composition time: a toolkit that includes interaction-requiring tools (approval-gated or ask-style) carries `HumanInteraction` in its `ToolkitAuthorities` (ticket 03), so the agent's layer requirements demand it as a typed dependency — it is never read optionally. When present, interactions surface as `interaction-requested` events (each request preceding the wait for its response), and the run awaits the correlated one-shot response — a Queue/Deferred-based adapter correlates external responses without turning the public stream into a bidirectional protocol. A toolkit without interaction tools has no `HumanInteraction` requirement, so interaction never appears in the stream. A denial resolves the tool as a `Failed` result the model can recover from.

## Context / Current State

The CLI blocks synchronously for approval (`ApprovalGate`/`ApprovalPrompt` in `packages/cli/src/approval-gate.ts`) and for `ask_user` (blocking terminal prompt) — no event projection. Ticket 03 fixes Effect AI's native approval protocol as the SDK seam; ticket 01 requires interactions be observable as `interaction-requested` events while the run waits on an injected one-shot channel. `HumanInteraction` is the ticket-02 typed request/response capability.

## Goals

- `interaction-requested` events with each request preceding the wait.
- Composition-time optionality: a toolkit with no interaction-requiring tools has no `HumanInteraction` requirement and emits no interaction events; runs proceed normally.
- Denials are model-visible `Failed` tool results, not run failures.
- The public stream stays one-way (events), never a bidirectional callback protocol.

## Non-Goals

- Authorization policy (approval modes) — that is a CLI/authz adapter concern (ticket 03), not core.
- Terminal prompts or remote callbacks — these are adapter implementations of `HumanInteraction`.
- Interaction timeout policy details beyond typed interaction failures.

## Invariants

- An `interaction-requested` event precedes the wait for that response; the run resumes with the correlated one-shot response.
- A toolkit/profile with no interaction-requiring tools has no `HumanInteraction` requirement and emits no `interaction-requested` events.
- A denial is a `Failed` tool result (recoverable); only interaction-capability failures fail the run (as typed `AgentError` via the failure channel, not the interaction semantics).
- The stream never exposes a request channel back to the consumer.

## Design Constraints

- `HumanInteraction` is a typed `request → Effect<response, error>` capability (ticket 02) that is a **required dependency** whenever the selected toolkit's `ToolkitAuthorities` includes it (ticket 03). The run loop `yield* HumanInteraction`; because the requirement lives in the Layer `R` channel, a profile that selects approval tools without providing `HumanInteraction` fails typecheck. Optionality is expressed only by which toolkit/profile is composed — never by an optional context read (no `Effect.serviceOption`).
- Non-interactive deployments that still select approval tools provide an automatic-policy adapter (auto-deny by default, matching the CLI's non-interactive semantics) that implements the same `HumanInteraction` contract; interactive deployments provide the Queue/Deferred-backed adapter. This is a concrete adapter choice, not a missing service — a native approval request is never silently approved.
- Correlation uses a Queue/Deferred-based adapter: the run publishes the request and awaits the one-shot response; the external caller answers asynchronously.
- Effect AI native approval requests project to `interaction-requested` (ticket 03); the runtime resolves them through this typed boundary and supplies the native approval response to the next model turn.

## Types, Interfaces, and APIs

```ts
interface HumanInteraction {
  readonly request: (input: InteractionRequest) => Effect<InteractionResponse, HumanInteractionError>
}

type InteractionRequest = ToolApprovalRequest | UserQuestion
// ToolApprovalRequest = { toolName, callId, input }   (projected from Effect AI native approval)
// UserQuestion        = { question }                  (projected from an ask-style tool)

type InteractionResponse =
  | { readonly _tag: "Approved" }
  | { readonly _tag: "Denied"; readonly reason?: string }
  | { readonly _tag: "Answered"; readonly answer: JsonValue }

type HumanInteractionError = { readonly _tag: "HumanInteractionError"; readonly reason: InteractionErrorReason }
// InteractionErrorReason = timeout | channel-closed | invalid-response

type AgentEvent = // extended
  | { readonly type: "interaction-requested"; readonly request: InteractionRequest }
  // + the slices 14/15 events
```

## Seams, Boundaries, and Adapters

- **`HumanInteraction` seam**: a required dependency carried in the selected toolkit's `ToolkitAuthorities` (ticket 03). Non-interactive deployments provide an automatic-policy adapter (auto-deny); interactive deployments provide the Queue/Deferred-backed adapter. A toolkit with no interaction tools has no `HumanInteraction` requirement, so no events are emitted and no adapter is needed.
- **Native-approval seam**: Effect AI's approval metadata/protocol (ticket 03) projects to `interaction-requested`; the response is mapped back to the native approval response for the next turn.
- **Test seam**: a scripted/Queue-based `HumanInteraction` helper (records requests, scripted responses) — the core analogue of the CLI's scripted approval tests.

## Call Stacks and Data Flow

```txt
tool turn (slice 15) encounters an interaction (native approval / ask-style tool)
  toolkit includes interaction tools (HumanInteraction in ToolkitAuthorities)?
    yes (required dependency):
      emit interaction-requested { request }
      await HumanInteraction.request(input)            // Queue/Deferred-correlated one-shot
        response:
          Approved  -> supply native approval to next model turn; continue
          Denied    -> ToolOutcome Failed (model-visible); continue
          Answered  -> supply answer as tool result; continue
        HumanInteractionError -> typed AgentError (interaction-capability failure)
    no:
      no interaction-requested event; run proceeds without interaction
```

Current vs proposed: today the CLI blocks on terminal prompts inline; core emits the event and waits through the injected capability, keeping the stream one-way.

## Files to Add / Change / Delete

- Add `packages/core/src/capabilities/human-interaction.ts` — `HumanInteraction` service, `InteractionRequest`/`InteractionResponse`/`HumanInteractionError`.
- Change `packages/core/src/agent/agent-event.ts` — add `interaction-requested`.
- Change `packages/core/src/agent/prodigy-agent.ts` — `HumanInteraction` dependency (required when the selected toolkit's authorities include it), projection, await-and-resume, denial → `Failed`.
- Add `packages/core/src/capabilities/__integration__/helpers.ts` additions — scripted/Queue-based `HumanInteraction` helper.
- Add `packages/core/src/agent/__integration__/interaction.integration.test.ts` — the RGR slices below.
- Delete none.

## RGR TDD Test Plan

Vertical red-green-refactor slices, integration-first through the public stream:

- R1: **capability present, approve** — red: a tool requiring interaction emits `interaction-requested` before waiting, then resumes with the approved response and the model continues. Implement projection, await, and resume.
- R2: **denial is recoverable** — red: a `Denied` response resolves the tool as a `Failed` result and the run continues (no stream failure).
- R3: **toolkit without interaction tools** — red: a toolkit/profile with no interaction-requiring tools emits no `interaction-requested` event and the run proceeds normally, with no `HumanInteraction` requirement to satisfy.
- R4: **correlation/ordering** — red: two interactions in one run correlate each `interaction-requested` to its own response, each request preceding its response.
- R5: **capability failure** — red: a `HumanInteractionError` (e.g. timeout/channel-closed) fails the run with the typed error, not a denial.
- R6 (unit): **request/response correlation edges** — pure correlation-booking logic that is impractical to reach through the stream, per the guide.

## Risks and Open Questions

- How Effect AI's native approval protocol surfaces in the stream version in use (pause vs approval part) — confirm against the catalog version before wiring projection.
- Whether `HumanInteractionError` maps to `AgentError` as a dedicated member or through an existing one — ticket 01's union has no interaction member, so decide the projection (likely a `RemoteError`-style or new reason) and record it.

## Acceptance criteria

- [ ] `HumanInteraction` is a typed `request → Effect<response, error>` capability that is a required dependency of the agent whenever the selected toolkit's `ToolkitAuthorities` includes it; it is never read via an optional context access.
- [ ] A scripted/Queue-based `HumanInteraction` helper is added to the integration helpers.
- [ ] Integration tests drive the run end-to-end and assert: with an interaction-requiring toolkit (and its `HumanInteraction` adapter) a tool requiring interaction emits `interaction-requested` before waiting then resumes with the correlated response; a toolkit without interaction tools emits no `interaction-requested` event and runs normally; an interaction denial is a model-visible failed tool result, not a run failure.
- [ ] Unit tests are limited to hard-to-reach branches (e.g. request/response correlation edge cases) per the testing guide `specs/guides/testing-core-integration.md`.
- [ ] `bun run test --run` in `packages/core` passes.

## Blocked by

15-implement-tool-call-and-tool-result-events.md — must complete first.
