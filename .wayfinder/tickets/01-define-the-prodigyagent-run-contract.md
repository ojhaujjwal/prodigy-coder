---
title: Define the ProdigyAgent Run Contract
type: wayfinder:grilling
status: closed
assignee: codex
parent: ../map.md
blocked_by: []
---

# Define the ProdigyAgent Run Contract

## Question

What are the exact public contracts for `ProdigyAgent`, `AgentRun`, structured event streaming, terminal results, typed failures, cancellation, and session identity? Define the smallest useful service contract that supports the current CLI, Ralph-style consumers, and later remote transports.

## Resolution

**Date:** 2026-08-01

`AgentRun` is not a public type or handle. A run is a lazy, composable Effect description exposed through the canonical `ProdigyAgent` service:

```ts
export class ProdigyAgent extends Context.Service<ProdigyAgent, {
  readonly run: (request: RunRequest) => Stream.Stream<AgentEvent, AgentError>
}>()("prodigy/ProdigyAgent") {}
```

The smallest request contract is one logical prompt plus explicit session and turn policy:

```ts
type RunRequest = {
  readonly prompt: string
  readonly sessionId?: SessionId
  readonly maxTurns?: PositiveInt
}
```

- Calling `run` performs no effects. Consuming the stream starts execution; each consumption is a fresh run with a fresh `RunId`.
- `SessionId` identifies durable conversation state. If omitted, the run creates a new session. If supplied, it must resolve; a missing session fails with `SessionNotFound` and is never silently replaced.
- `RunId` identifies one invocation and is emitted with the resolved `SessionId` in `run-started`.
- `maxTurns` is an optional per-run override within the configured profile's resource bounds.

The v1 semantic event vocabulary is:

```ts
type AgentEvent =
  | { readonly type: "run-started"; readonly runId: RunId; readonly sessionId: SessionId }
  | { readonly type: "turn-started"; readonly turn: number }
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call"; readonly callId: string; readonly toolName: string; readonly input: JsonValue }
  | { readonly type: "tool-result"; readonly callId: string; readonly toolName: string; readonly outcome: ToolOutcome }
  | { readonly type: "interaction-requested"; readonly request: InteractionRequest }
  | { readonly type: "run-ended"; readonly result: AgentResult }
```

Effect AI response parts, provider metadata, debug logs, usage events, formatting, and error events remain behind adapters. Tool events use JSON-safe payloads and tagged success/failure outcomes. Approval denials and ordinary tool failures are failed tool results so the model can recover; only tool-system failures fail the run.

Successful runs emit exactly one `run-ended` event and then complete normally. The result carries metadata only:

```ts
type AgentResult =
  | { readonly _tag: "Finished"; readonly sessionId: SessionId; readonly turns: number; readonly finishReason: AgentFinishReason }
  | { readonly _tag: "Stopped"; readonly sessionId: SessionId; readonly turns: number; readonly reason: "max-turns"; readonly limit: number }
```

`AgentFinishReason` is Prodigy-owned and maps provider-specific finish values to recovery-relevant semantics. Streamed text and the persisted transcript are not duplicated in the result.

`AgentError` is a union of concrete tagged errors, not another runtime wrapper:

```ts
type AgentError =
  | InvalidRunRequest
  | SessionNotFound
  | SessionStorageError
  | ModelError
  | ToolSystemError
  | RemoteError
```

`ModelError` owns a provider-neutral reason union covering transport, authentication, rate limit, quota, invalid request, content policy, invalid output, and provider failure. Retryability is derived from the concrete reason. Run-level retries belong to callers and `HarnessLoop`; provider adapters may safely retry an individual model request.

Cancellation is Effect interruption. Early consumer cancellation interrupts the run and runs finalizers; it does not emit `run-ended` or become an `AgentError`. Human interaction is an optional `HumanInteraction` capability at composition time (a toolkit with no interaction tools has no such requirement): requests are visible as events, while a Queue/Deferred-based adapter correlates external responses without turning the public stream into a bidirectional protocol.

Event ordering is causal: `run-started` is first; tool calls precede matching results; interaction requests precede the wait for their response; no events follow `run-ended`; failures and interruption may terminate without `run-ended`.
