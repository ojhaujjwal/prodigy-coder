---
title: Define Typed Toolkit Profiles and Custom Tool Composition
type: wayfinder:grilling
status: closed
assignee: codex
resolution_date: 2026-08-01
parent: ../map.md
blocked_by: []
---

# Define Typed Toolkit Profiles and Custom Tool Composition

## Question

How can callers replace, extend, and select typed Effect AI toolkits without hard-coding `AgenticToolkit` into the agent loop? Define built-in defaults, custom toolkit Layers, agent profiles, tool governance, and the boundary between tool definitions, handlers, and execution authorities.

## Resolution

**Date:** 2026-08-01

The toolkit boundary uses Effect AI's own typed `Toolkit` values and Layer algebra. Prodigy does not introduce a parallel toolkit builder or an untyped registry.

The profile is a plain typed value bound once at runtime construction:

```ts
type AgentProfile<TToolkit extends Toolkit.Any> = {
  readonly toolkit: TToolkit
  readonly toolkitLayer: Layer.Layer<
    Tool.HandlersFor<Toolkit.Tools<TToolkit>>,
    never,
    ToolkitAuthorities
  >
  readonly systemPrompt: string
  readonly maxTurns: PositiveInt
}
```

`ToolkitAuthorities` is the dependency set required by the selected handler Layers. It may include `Workspace`, `CommandExecutor`, and `HumanInteraction` when the selected tools need them. The profile does not own `LanguageModel`, `SessionStore`, execution authorities, session identity, or approval decisions.

The composition root binds the generic toolkit while keeping the public agent service stable:

```ts
const makeProdigyAgentLayer = <TToolkit extends Toolkit.Any>(
  profile: AgentProfile<TToolkit>
): Layer.Layer<ProdigyAgent, never, ToolkitAuthorities | LanguageModel | SessionStore> => ...
```

The exact toolkit type is hidden only after the compiler has checked the toolkit/handler pairing. No unchecked casts, dynamic toolkit mutation, or per-run toolkit selection is part of the core API. Per-run requests may override bounded execution policy as defined by [Define the ProdigyAgent Run Contract](01-define-the-prodigyagent-run-contract.md), but cannot replace the profile toolkit.

Composition is direct Effect AI composition:

```ts
const toolkit = Toolkit.merge(AgenticToolkit, CustomToolkit)
const toolkitLayer = Layer.merge(AgenticToolkitLayer, CustomToolkitLayer)
```

Later definitions replace same-name definitions. Replacing a tool means replacing its complete typed definition—schema, description, failure/result shape, and handler—not merely changing an untyped function in a shared map. Custom and remote tools remain ordinary Effect AI `Tool` definitions; remote execution is expressed by the handler's authority Layer.

The existing `AgenticToolkit` surface is migration input and the compatibility default: its tool names, model-facing schemas, exported definitions, and result shapes remain stable initially. Its canonical handlers must be migrated behind the separate `Workspace`, `CommandExecutor`, and optional `HumanInteraction` services established by [Define Capability Services and Layer Composition](02-define-capability-services-and-layer-composition.md). The current direct `FileSystem`, `Path`, `ChildProcessSpawner`, and terminal-prompt dependencies are not the target SDK boundary.

Tool definitions remain model-facing values containing schemas, descriptions, failure modes, and Effect AI approval metadata. Stable execution authorities are acquired by dependency-preserving handler Layers. Handlers parse existing string inputs into authority types such as `WorkspacePath` and `CommandRequest`, then project authority outcomes into the tool's compatibility surface. Exact per-tool failure schemas are intentionally deferred to [Define Built-in Tool Failure Schemas](09-define-built-in-tool-failure-schemas.md).

Effect AI's native approval protocol is the SDK seam. Native approval requests project to the existing `interaction-requested` event in [Define the ProdigyAgent Run Contract](01-define-the-prodigyagent-run-contract.md); the runtime resolves them through the typed interaction/authorization boundary and supplies the native approval response to the next model turn. Denials remain model-visible tool results. The existing CLI `ApprovalGate`, `approvalMode`, non-interactive behavior, and integration-test semantics remain a compatibility adapter; `withApproval` is not the canonical SDK governance mechanism.
