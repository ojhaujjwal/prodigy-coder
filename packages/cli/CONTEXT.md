# Prodigy CLI

This context defines the language for the current Prodigy command-line application. The CLI currently owns its invocation, provider, tool, session, approval, skill, and output behavior; it is being prepared for a later migration to the runtime-neutral contracts in `packages/core`.

## Invocation And Configuration

**CLI invocation**:
One user-facing command execution that parses input, selects configuration, runs the current agent loop, and presents the result.

**Configuration**:
The effective CLI policy assembled from defaults and user-provided configuration. It includes provider selection, turn limits, approval behavior, output format, session choice, system guidance, and interactive mode.

**Provider selection**:
The CLI choice of model service for an invocation. Provider-specific configuration belongs to the CLI boundary and is not the canonical meaning of a core run.

**Non-interactive mode**:
A CLI policy that cannot wait for a human prompt. Approval requests are denied and user-question tools are unavailable rather than being silently approved.

## Current Agent Vocabulary

**CLI agent loop**:
The current CLI-owned execution of user messages, model turns, tool calls, approvals, and session persistence. It is transitional vocabulary while the CLI still runs independently from the core package.

**OutputEvent**:
The CLI's presentation-oriented event vocabulary. It includes text deltas, tool calls and results, finish and error messages, and session information; it is not the same protocol as core's `AgentEvent`.
_Avoid_: AgentEvent

**Output format**:
The presentation contract used to render CLI events as human-readable text or stream JSON. A format controls presentation and compatibility fields, not the meaning of the underlying agent work.

**CLI session**:
Conversation state managed by the current CLI application, including its list and delete commands. It overlaps with core's future `Session` concept but remains a separate current model until migration is complete.

**Session continuation**:
The CLI request to use a prior session, supplied explicitly by a flag or environment value. The current CLI may apply its own fallback behavior when that session is unavailable; this must not be confused with core's explicit continuation semantics.

## Tools And Approval

**CLI tool**:
A model-facing operation currently wired by the CLI to local providers and local execution behavior. The later core migration will move the stable tool contract and authority boundary into core while leaving CLI policy in this context.

**Approval mode**:
The CLI policy selecting which tool calls require approval: `none`, `dangerous`, or `all`.

**ApprovalGate**:
The CLI policy boundary that applies the selected approval mode to a tool call and decides whether to allow, deny, or request approval.

**Approval prompt**:
The terminal interaction used to collect an approval decision for a gated tool call. It is a CLI presentation adapter, not the canonical interaction contract for all deployments.

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

The CLI currently owns terminal input and output, command-line flags, provider configuration, local tool wiring, approval policy, skill discovery, output compatibility, and CLI session management. The later migration will make the CLI an adapter over core's run, event, error, toolkit, session, and authority contracts; until then, similarly named CLI and core values must not be treated as interchangeable.
