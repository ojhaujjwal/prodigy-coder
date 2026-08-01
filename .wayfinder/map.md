# Prodigy SDK and Ralph Harness

**Label:** `wayfinder:map`
**Status:** open

## Destination

Produce an implementation-ready architecture for an Effect-native Prodigy SDK that supports custom tools, local and remote sandboxes, and a Ralph-compatible harness loop. The result specifies service boundaries, runtime composition, deployment protocol, and migration order without implementing the system during wayfinding.

## Notes

Domain: Effect TypeScript agent runtimes and autonomous coding harnesses.

Consult `effect-service-design`, `domain-modeling`, `grilling`, `coding-standards`, and `tech-spec` while resolving tickets. Planning is the default; implementation begins only after the route is clear.

Established constraints from the destination discussion:

- Hybrid deployment: the in-process Effect runtime is canonical; remote sandboxes are adapters.
- Effect APIs are canonical, with `ManagedRuntime` and convenience facades for ordinary TypeScript consumers.
- Toolkits are typed and composed at runtime construction; built-in tools are replaceable or extendable through agent profiles.
- The core depends on application-owned `Workspace` and `CommandExecutor` authorities.
- Sessions use a replaceable `SessionStore`, with file storage as the local default.
- The Ralph-style loop is separate and consumes a generic `AgentRunner`.
- Providers are caller-configured Effect Layers; the core depends only on `LanguageModel`.
- Agent output is a structured Effect `Stream`; formatting belongs to adapters.
- Human approval and questions start as an injectable Effect service.
- Remote sandboxes are treated as untrusted.
- Core SDK operations are explicit: lookup failures remain typed outcomes, and compatibility fallbacks belong at adapters rather than being inferred by the core.
- Existing CLI behavior remains compatible; the shell composes the new SDK/harness.

## Decisions so far

<!-- Closed tickets only. Open tickets are discovered from .wayfinder/tickets/. -->

- [Define the ProdigyAgent Run Contract](tickets/01-define-the-prodigyagent-run-contract.md) — The canonical API is a lazy Effect service returning semantic `AgentEvent`s with explicit session identity, typed union failures, terminal results, and interruption-based cancellation.
- [Define Capability Services and Layer Composition](tickets/02-define-capability-services-and-layer-composition.md) — Separate Workspace, CommandExecutor, SessionStore, and HumanInteraction authorities compose through explicit Layers and one caller-owned ManagedRuntime; Effect built-ins provide observability.
- [Define Typed Toolkit Profiles and Custom Tool Composition](tickets/03-define-typed-toolkit-profiles-and-custom-tool-composition.md) — Effect AI `Toolkit` values and Layers compose typed, runtime-fixed profiles; existing tools remain a compatibility surface while handlers migrate behind the authorities established by Define Capability Services and Layer Composition, and native approval adapts the existing CLI policy.
- [Define SessionStore Checkpoint Semantics](tickets/04-define-sessionstore-checkpoint-semantics.md) — Session state is committed as versioned, atomic transcript snapshots with prompt-first and complete-turn checkpoints; optimistic revisions prevent lost updates, while interruption recovery and continuation remain caller policy.

## Not yet specified

- How remote sandbox messages are transported and resumed.
- Session retention policy and administrative lifecycle beyond runtime create/load/save.
- Harness retry, interruption, commit, rollback, and partial-progress semantics.
- Package boundaries, export maps, versioning, and compatibility guarantees.
- Observability, quotas, multi-tenant identity, and worker scheduling.

## Out of scope

- Implementing the SDK or harness before the architectural route is clear.
- Rebuilding provider-specific clients; they remain caller-owned adapters.
- Replacing the existing CLI’s user-facing behavior as part of this map.
