# Prodigy Core

This context defines the language for Prodigy's runtime-neutral agent core. It owns the contracts for bounded agent runs, model-facing tools, durable conversation state, and abstract execution authorities; it does not own a CLI, terminal, concrete workspace, process runtime, or sandbox.

## Agent Runtime

**ProdigyAgent**:
The core agent capability that executes a single run using a selected profile, conversation state, model, tools, and supplied execution authorities.

**Run**:
A bounded attempt to apply one logical prompt to a session. A run has its own invocation identity and may update durable conversation state, but it is not a durable process, replay log, or handle that can be resumed.

**RunId**:
The identity of one invocation of a run. It correlates progress from that invocation and is distinct from the `SessionId` that names durable conversation state.

**Continuation**:
A fresh run that loads an existing session and supplies a new prompt. Continuation does not replay an interrupted run or silently select a replacement session when the requested session cannot be found.

**Cancellation**:
External interruption of a run before it reaches a terminal outcome. Cancellation is not a successful result and is not converted into an agent failure.

**AgentEvent**:
The stable progress vocabulary for a run. Events describe run lifecycle, turns, streamed text, tool calls and results, and requests for human interaction without exposing provider-specific response parts.
_Avoid_: OutputEvent, provider response part

**AgentResult**:
The terminal outcome of a successfully completed run. It carries run metadata and an agent-owned finish or stop reason rather than repeating streamed text or the complete session transcript.

**AgentError**:
The stable failure vocabulary for the core. It distinguishes failures in the model, tool orchestration, session state, execution authorities, and human interaction without making provider-specific error names part of the domain.

## Tools And Profiles

**Tool definition**:
A model-facing operation contract containing its name, purpose, input and result shape, failure behavior, and any approval requirement. A tool definition does not choose the workspace, command, interaction, or other authority that will execute it.

**Toolkit**:
The declared set of tool definitions available to an agent profile, together with the rules governing their execution.

**Toolkit composition**:
The deliberate construction of a toolkit from existing definitions. A caller may use the default toolkit, replace a definition by name, add definitions, or compose a toolkit from scratch; same-name replacement is intentional.

**Agent profile**:
A named set of defaults for one agent instance, including its toolkit, tool execution rules, system guidance, and turn bound. A run may use a smaller bounded execution policy, but it cannot replace the profile's toolkit.

**Profile binding**:
The act of connecting a profile's toolkit and execution rules to the authorities required by those tools, producing a usable agent capability without allowing the toolkit to change during a run.

**Tool governance**:
The rules for deciding whether a tool call may execute, including approval requirements and the handling of approval responses. A denial is a model-visible failed tool result; a failure of the governance protocol itself is an agent failure.

## Execution Authorities

**Execution authority**:
An agent-facing boundary through which a run can affect or observe the outside world. Core defines the contract; a composition root or adapter supplies the concrete authority and its policy.

**Workspace**:
The authority for reading and mutating files within a scoped project environment. A workspace defines the boundary of accessible project content, but core does not prescribe a local filesystem or a particular isolation mechanism.

**CommandExecutor**:
The authority for running structured commands under an explicit execution and resource policy. A non-zero command exit is a command result; spawn, timeout, interruption, transport, and resource failures are execution failures.

**HumanInteraction**:
The one-shot request and response channel for tool approval or user questions. Terminal prompts, remote callbacks, and automatic non-interactive policies are possible adapters for the same authority.

**SkillRepository**:
The authority for looking up named skills and identifying skills that may be offered to the model. Skill discovery, file formats, and source precedence belong to an adapter rather than to the lookup contract.

## Conversation State

**Session**:
Durable conversation state identified by a `SessionId`. It contains the committed message history and its storage timestamps; it is not a running agent or a run handle.

**SessionId**:
The identity that selects one durable conversation state. It is distinct from the `RunId` of an invocation and must be supplied explicitly when a run continues an existing session.

**SessionStore**:
The replaceable authority for creating, loading, and conditionally saving sessions. It owns committed conversation state and concurrency checks, but not run orchestration, retention policy, rollback of external effects, or the effects themselves.

**Session checkpoint**:
A committed boundary in a session's conversation history. The prompt and completed exchanges become checkpoints; streamed fragments and incomplete exchanges are not committed state.

**Session revision**:
The identity of a committed session snapshot used to detect competing updates. A revision is storage concurrency metadata, not part of the conversation's meaning.

**Session conflict**:
The outcome of attempting to save a checkpoint against a session revision that is no longer current. A conflict protects the newer committed state rather than silently overwriting it.

## Boundaries

Core is the canonical owner of run, event, error, toolkit, profile, session, and authority-contract language. Concrete terminal behavior, provider selection, local file and process policy, sandbox implementation, output formatting, and outer harness policy belong to adapters or application contexts.
