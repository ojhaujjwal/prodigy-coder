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

**Agent profile**:
A named, runtime-bound plain typed value for one agent instance. It selects one typed toolkit and the policies governing its use across that instance's runs, including behavior defaults such as the system prompt and turn limit. A run may override bounded execution policy, but it cannot replace the profile's toolkit. Providers, execution authorities, session identity, and approval decisions remain outside the profile.

**Typed profile binding**:
The generic composition step that checks a profile's toolkit against its handler Layers and closes over the validated result in a stable `ProdigyAgent` service. The exact toolkit type is hidden after construction; no dynamic toolkit mutation or unchecked type escape is permitted. Profile handler Layers preserve their requirements on the canonical capability services; composition roots provide concrete local or remote authorities.

**Toolkit composition**:
The explicit construction of an agent's available tools using Effect AI's `Toolkit` values and merge semantics. Callers may use the built-in toolkit, replace a built-in definition, add custom tools, or compose a toolkit from scratch. Same-name replacement is intentional; there is no parallel Prodigy toolkit builder or implicit handler selection.

**Tool governance**:
Effect AI's native approval metadata and approval-response protocol are the SDK seam when a toolkit declares approval requirements. The existing CLI `ApprovalGate` and `approvalMode` remain the first authorization adapter and must preserve their current `none`, `dangerous`, `all`, and non-interactive behavior; this model does not infer a new built-in sensitivity policy.

Native approval requests are projected as the existing `interaction-requested` agent event with a typed tool-approval request. The runtime awaits the interaction response, supplies Effect AI's native approval response to the next model turn, and preserves denial as a tool result.

**Tool definition**:
The model-facing, typed Effect AI `Tool` value: its name, description, parameter and result schemas, failure mode, and approval metadata. It does not choose a local or remote execution authority.

**Tool compatibility surface**:
The existing built-in tool names, model-facing parameter schemas, and result shapes remain stable during re-architecture. Handlers parse and translate those inputs into canonical authority types such as `WorkspacePath` and `CommandRequest`, then project authority outcomes back into the tool's declared result/failure shape.

The exact per-tool failure schemas remain an open follow-up: the current tools predate the `Workspace` and `CommandExecutor` error families, so this ticket fixes only the translation boundary.

**Remote tool**:
An ordinary typed tool whose handler delegates to a remote authority. Remote execution is a property of the handler's dependencies and Layer, not a separate tool kind or toolkit composition mechanism.

**Handler Layer composition**:
The handler context for a composed toolkit is assembled with Effect's Layer algebra. A toolkit merged from built-in and custom definitions may use the corresponding merged handler Layers; later definitions own same-name execution.

**Built-in profile**:
The ready default profile for ordinary local execution. For the first migration it reuses the existing `AgenticToolkit` and `AgenticToolkitLayer`; CLI-specific approval and non-interactive behavior remains in `makeToolkitLayer(config)`. It is a thin composition, not a toolkit builder or a second tool model.

**Built-in toolkit**:
The existing `AgenticToolkit` tool surface is migration input for the SDK's default Effect AI toolkit. Its definitions and compatibility exports may be reused, but canonical handlers must depend on the separate `Workspace`, `CommandExecutor`, and optional `HumanInteraction` authorities rather than platform services directly.

**AgentRunner**:
The contract used by an outer harness to start an agent run and consume its progress. Prodigy, OpenCode, and remote workers can each implement it.

**SessionStore**:
The replaceable authority for committed conversation state. It creates and loads sessions and accepts conditional checkpoints; it does not own run orchestration, retention, locking, or rollback of external effects.

**Session checkpoint**:
A durable boundary in a session's conversation history. The user prompt is checkpointed before model execution, and each completed assistant/tool exchange is checkpointed before another model turn. Stream fragments and incomplete exchanges are not committed state.

**Session revision**:
The identity of a committed session snapshot used to detect competing updates. A revision is storage concurrency metadata, not part of the conversation's meaning.

**Session continuation**:
A fresh agent run that loads an existing session by `SessionId` and supplies a new prompt. Continuation does not implicitly resume an interrupted run or replay its effects.

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

## Packages

**`@prodigy/core`**:
The canonical SDK package. It owns `ProdigyAgent`, the generic `AgentRunner` contract, agent events and errors, capability services, typed toolkit composition, built-in tools, and local filesystem/process adapters. Local adapters implement core authorities; their runtime-specific Layers are supplied by the composition root.

**Ralph harness package**:
A possible package for the Ralph-specific outer loop. It would consume the generic `AgentRunner` contract from `@prodigy/core` and own prompt, progress, checks, completion, retry, interruption, and Git policy. Whether it is published as `@prodigy/ralph-harness` or remains an application-level composition is unresolved.

**`@prodigy/cli`**:
The separate command-line adapter. It owns flags, configuration, terminal I/O, output formatting, Bun startup, and compatibility behavior while composing `@prodigy/core`.

**Specialized package**:
A future package for an alternative execution scenario, such as a remote workspace or container sandbox. It depends on core authorities and supplies alternative Layers; it is not part of the initial package split.
