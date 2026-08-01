# Prodigy Agent Harness

This context defines the shared language for turning Prodigy into a reusable agent engine and using it as the agent engine for a Ralph-style harness. It covers the agent runtime, execution authorities, remote sandboxes, and the outer harness loop.

## Agent Runtime

**ProdigyAgent**:
The core agent capability that executes one agent run using a configured model, toolkit, session store, and execution authorities. Its canonical public API is an Effect `Context.Service` whose `run` method returns a lazy `Stream<AgentEvent, AgentError>`; convenience facades adapt this service rather than replacing it.

**Run**:
A bounded execution of one logical prompt against a session, producing progress events and a terminal outcome. `ProdigyAgent.run()` is a lazy, composable Effect description; execution, session resolution, and run identity creation begin only when its stream is consumed. A run has a generated `RunId` for invocation-level correlation and a `SessionId` for durable conversation state; it is not exposed as a separate handle or aggregate. Its public event stream emits one `run-ended` event carrying a tagged `Finished` or `Stopped` result, then ends normally to signal completion. A supplied session identity must resolve explicitly; a lookup failure never silently selects a replacement session. External cancellation is represented by Effect interruption rather than a run result.

Each consumption of the run stream is a fresh execution with a fresh `RunId`; the stream is not a replay log or shared execution handle.

Consumer cancellation propagates as Effect interruption, runs resource finalizers, and does not emit a terminal result or convert cancellation into `AgentError`.

`ProdigyAgent` does not replay a failed run automatically. Run-level retry and recovery policy belongs to callers such as `HarnessLoop`; lower-level provider adapters may perform safe retries for an individual model request.

**Explicit core**:
Core SDK operations make creation, lookup, fallback, and recovery behavior explicit in their inputs and outcomes. Compatibility adapters may add forgiving policy, but the core does not infer it from missing data.

**AgentError**:
The stable failure union of the core SDK. It is a compile-time union of concrete tagged errors such as session, model, tool-system, and remote failures rather than an additional runtime wrapper. Individual errors may own a discriminated `reason` when they have meaningful subcategories; retryability is derived from that reason rather than supplied as an unrelated boolean.

`ModelError.reason` uses recovery-oriented, provider-neutral categories such as transport, authentication, rate limit, quota, invalid request, content policy, invalid output, and provider failure.

**AgentEvent**:
The stable, transport-neutral event vocabulary for a coding-agent run. It is inspired by Effect AI response parts but is owned by Prodigy and exposes only coding-agent semantics needed by CLI, UI, CI, and remote consumers; provider response parts and formatting remain behind adapters.

Tool-call and tool-result events use JSON-safe payloads and a tagged success/failure outcome. A tool failure can be reported to the model as a result without necessarily failing the whole run.

Events preserve causal order: one `run-started` comes first; each tool call precedes its matching result; interaction requests precede the wait for their response; successful runs emit exactly one `run-ended` followed by normal stream completion; failures and interruption may end without `run-ended`.

The v1 event vocabulary is limited to `run-started`, `turn-started`, `text-delta`, `tool-call`, `tool-result`, `interaction-requested`, and `run-ended`. Diagnostics, provider metadata, usage, and errors remain separate concerns.

Approval denials and ordinary tool execution failures are model-visible failed tool results so the agent can recover. `ToolSystemError` is reserved for failures that prevent tool orchestration, such as unknown-tool routing, toolkit misconfiguration, or protocol/serialization failure.

Per-run execution policy such as `maxTurns` may override the configured agent profile within its validated resource bounds; provider, model, toolkit, prompt, and authority composition remain profile/runtime concerns.

`AgentResult` carries terminal metadata such as session identity, turn count, and agent-owned finish or stop reason. It does not repeat streamed text or the persisted transcript. Provider-specific finish values are mapped to an `AgentFinishReason` vocabulary at the model boundary.

**Toolkit**:
The declared set of tools that an agent profile may offer to the model, together with the rules governing their execution.

**AgentRunner**:
The contract used by an outer harness to start an agent run and consume its progress. Prodigy, OpenCode, and remote workers can each implement it.

## Execution Boundaries

**Workspace**:
The agent-facing authority for reading and writing files within a scoped project environment.

**CommandExecutor**:
The agent-facing authority for running commands under an explicit execution and resource policy.

**Sandbox**:
An untrusted execution environment that implements workspace and command authorities while enforcing isolation, limits, cancellation, and policy.

**HumanInteraction**:
The interaction channel through which an agent requests approval or user input. Terminal prompts, remote callbacks, and policy decisions are interchangeable forms. A request is observable as an `AgentEvent`, while the injected Effect service waits for the one-shot response; the public stream remains a one-way event projection rather than a bidirectional callback protocol. This is an optional capability: non-interactive deployments provide an explicit automatic policy.

## Harness

**HarnessLoop**:
The outer iterative controller that builds prompts, invokes an `AgentRunner`, runs checks, tracks progress, interprets completion signals, and applies Git policy.

**Prodigy CLI**:
The compatibility entrypoint that parses command-line input and composes the Prodigy SDK; it is not the agent runtime itself.
