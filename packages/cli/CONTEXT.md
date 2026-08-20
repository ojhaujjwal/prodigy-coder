# Prodigy CLI

This context defines the language for the Prodigy command-line adapter. The CLI owns invocation, provider configuration, terminal interaction, skills, commands, and output compatibility; `packages/core` owns agent runs, tools, sessions, and capability contracts.

## Invocation And Configuration

**CLI invocation**:
One user-facing command execution that parses input, selects configuration, runs `ProdigyAgent`, and presents translated core events.

**Configuration**:
The effective CLI policy assembled from defaults and user-provided configuration. It includes provider selection, turn limits, approval behavior, output format, session choice, system guidance, and interactive mode.

**Provider selection**:
The CLI choice of model service for an invocation. Provider-specific configuration belongs to the CLI boundary and is not the canonical meaning of a core run.

**Non-interactive mode**:
A CLI policy that cannot wait for a human prompt. Approval requests are denied and user-question tools are unavailable rather than being silently approved.

## Agent Vocabulary

**Core agent run**:
The core-owned execution of prompts, model turns, tool calls, approvals, checkpoints, and terminal results. The CLI consumes its lazy event stream.

**OutputEvent**:
The CLI's presentation-oriented event vocabulary. It includes text deltas, tool calls and results, finish and error messages, notices, and session information; it is not the same protocol as core's `AgentEvent`.
The CLI translates `AgentEvent` to `OutputEvent` only at the presentation boundary, and the translation is total: every core event is either projected into presentation events or explicitly treated as presentation-internal.

**Notice**:
A CLI-generated presentation event for invocation-time messages that are not part of the model's output (for example, announcing that a missing session is being restarted). It flows through the same output formats as model output; in stream-JSON it renders as content text so the wire protocol stays stable.

**Output format**:
The presentation contract used to render CLI events as human-readable text or stream JSON. A format controls presentation and compatibility fields, not the meaning of the underlying agent work.

**Session administration**:
CLI list and delete commands operating on the core `FileSessionStore` format.

**Session continuation**:
The CLI request to use a prior session, supplied explicitly by a flag or environment value. The CLI retains its missing-session notice and retries as a new run; core continuation itself remains explicit.

## Tools And Approval

**Core tool**:
A model-facing operation defined and handled by core against CLI-provided capability layers.

**Approval mode**:
The CLI policy selecting which tool calls require approval: `none`, `dangerous`, or `all`.

**Approval policy**:
The CLI predicate selecting which core tool calls require human approval.

**Human interaction adapter**:
The CLI terminal implementation of core `HumanInteraction` for approvals and user questions.

## Skills And Commands

**Skill**:
A named piece of model guidance discovered by the CLI, with descriptive metadata, content, and a flag controlling whether it may be offered automatically.

**Skill discovery**:
The CLI process of finding skill files from its supported sources, parsing their metadata, applying source precedence, and building the available skill index.

**Skill command**:
The CLI slash-command form that explicitly selects a named skill and combines its guidance with a user prompt.

**Session command**:
A CLI management command for listing or deleting the CLI's persisted sessions. It is application management behavior, not part of the core run contract.

## Ownership Boundary

The CLI owns terminal input and output, command-line flags, provider configuration, approval policy, skill discovery, output compatibility, and session administration. Core owns the run, event, error, toolkit, session persistence, and capability contracts. The CLI supplies `Workspace`, `CommandExecutor`, `HumanInteraction`, and `SkillRepository` implementations.
