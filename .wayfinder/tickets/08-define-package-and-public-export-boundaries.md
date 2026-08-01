---
title: Define Package and Public Export Boundaries
type: wayfinder:grilling
status: closed
resolution_date: 2026-08-01
assignee: codex
parent: ../map.md
blocked_by:
  - 01-define-the-prodigyagent-run-contract.md
  - 02-define-capability-services-and-layer-composition.md
---

# Define Package and Public Export Boundaries

## Question

Should the work remain a single package with layered entrypoints or become separate core, runtime, CLI, harness, and protocol packages? Define public exports, dependency direction, Bun/Node portability, peer dependencies, and the migration path from the current private `src/index.ts` package entrypoint.

## Resolution

**Date:** 2026-08-01

The repository becomes a Bun-managed monorepo with two committed initial packages. The package split follows ownership, not a one-directory-per-abstraction rule:

```text
packages/
  core/
    src/
      agent/          # ProdigyAgent, AgentRunner, run events, errors
      capabilities/   # Workspace, CommandExecutor, SessionStore, HumanInteraction
      toolkit/        # built-in tools, profiles, and typed toolkit composition
      local/          # local filesystem/process adapters and local Layers
      index.ts        # curated public exports
  cli/
    src/              # CLI commands, config, output, Bun startup
```

### Package ownership

- **`@prodigy/core`** is the canonical SDK. It owns the `ProdigyAgent` service, the generic `AgentRunner` contract, semantic run events and errors, capability services and Layers, typed toolkit/profile composition, built-in tool definitions and handlers, and the local filesystem/process implementations. Local implementations remain behind the `Workspace` and `CommandExecutor` authorities; putting them in this package does not make their platform details part of the agent contract.
- **The Ralph harness** owns `HarnessLoop` and Ralph policy: prompt construction, progress, checks, completion signals, retries, interruption policy, and Git/commit policy. It consumes `AgentRunner` from `@prodigy/core`; the core does not depend on the harness. Whether this becomes `@prodigy/ralph-harness`, remains an application-level composition, or takes another package shape is intentionally unresolved in [Decide Ralph Harness Package Boundary](10-decide-ralph-harness-package-boundary.md).
- **`@prodigy/cli`** owns command parsing, environment/file configuration, terminal interaction, output formatting, session administration commands, Bun startup, and compatibility behavior. It composes `@prodigy/core` and does not become the SDK entrypoint.

There is no initial standalone tools, local-runtime, protocol, provider, or platform package. Ralph package placement is intentionally left open. A future remote-workspace, container, or other specialized package will depend on `@prodigy/core` and provide alternative `Workspace`/`CommandExecutor` Layers. A separate protocol package is deferred until [Define the Remote Sandbox Protocol Boundary](05-define-the-remote-sandbox-protocol-boundary.md) establishes a wire contract that genuinely needs independent versioning.

### Dependency direction

```text
Ralph harness candidate ──────┐
@prodigy/cli ─────────────────┼──> @prodigy/core
future specialized adapters ──┘
```

The intended dependency rules are:

- `@prodigy/core` never imports `@prodigy/ralph-harness`, `@prodigy/cli`, or a specialized adapter.
- Any Ralph harness implementation depends on the core contracts, especially `AgentRunner`, `RunRequest`, `AgentEvent`, and `AgentError`; it does not depend on `ProdigyAgent` concretely.
- `@prodigy/cli` depends on the core and may depend on the harness only when a CLI command explicitly exposes Ralph functionality.
- Specialized packages depend inward on core-owned authorities and expose Layers; core never discovers or selects them implicitly.
- Provider-specific clients remain caller-configured Layers and are not pulled into the core package by the package split.

### Public exports

Each package has a curated root export and explicit documented subpaths. Internal source paths and wildcard exports are not public API.

`@prodigy/core` exports the stable agent contracts (`ProdigyAgent`, `AgentRunner`, `RunRequest`, `AgentEvent`, `AgentResult`, and `AgentError`), capability services and domain types, toolkit/profile composition, built-in toolkit values, and local adapter Layers. Provider-specific constructors, persistence records, raw platform services, and implementation helpers remain unexported unless a later ticket promotes them deliberately.

If the Ralph harness becomes a package, its root will export `HarnessLoop`, typed policy/configuration inputs, and harness outcomes/errors. It will re-export no core symbols; callers will import shared contracts from `@prodigy/core`.

`@prodigy/cli` exports only the documented executable/composition entrypoint needed for compatibility and tests. CLI flags, formatters, environment configuration, and Bun startup are not SDK exports.

### Runtime portability and dependencies

The core package is runtime-neutral: it imports no Bun or Node built-ins, reads no process globals during module import, and never starts a runtime as a side effect. Core local adapters use Effect platform service interfaces and require the caller to provide the matching runtime Layers. `@prodigy/cli` provides Bun services and calls `BunRuntime.runMain`; a Node consumer can provide the corresponding Node platform Layers without changing the core agent or authority contracts.

Published runtime packages use `effect` as a peer dependency so all services and Layers share one Effect installation. If Ralph becomes a published package, it should also treat `@prodigy/core` as a peer dependency because its public contract is defined by the core package. Workspace development lists those peers as development dependencies. The CLI is an application package with ordinary workspace/runtime dependencies, including Bun platform services; it is not the portability boundary.

`@prodigy/core` is the first public package to version and release. The CLI remains private and follows the repository release. Ralph versioning and any coordination with core are deferred until its package boundary is decided. Specialized packages join the coordinated release only after their public protocol is decided.

### Migration from the current package

1. Turn the repository root into a private workspace coordinator and add `packages/core` and `packages/cli` with package-local tests and curated export maps.
2. Move the existing CLI mechanically into `packages/cli` as a compatibility scaffold, including any temporarily colocated legacy modules it still needs. Preserve its current behavior and do not treat this lift-and-shift surface as the final SDK-aligned design.
3. Build `@prodigy/core` independently from the resolved contracts: agent runtime, session/capability services, built-in tools, local adapters, public exports, and tests. Use the current implementation as behavioral reference material while keeping core independent of the CLI scaffold.
4. Validate the core SDK through its public API and real local Layers, then rebuild the `@prodigy/cli` composition against `@prodigy/core`'s public exports. Preserve user-visible behavior through compatibility tests and remove the duplicated legacy modules.
5. Decide and implement the Ralph package boundary separately through [Decide Ralph Harness Package Boundary](10-decide-ralph-harness-package-boundary.md), after [Define the HarnessLoop and AgentRunner Contract](06-define-the-harnessloop-and-agentrunner-contract.md) settles the harness contract.

This is a package and public-boundary decision, not an implementation of the monorepo migration. Build, release automation, the CLI rebuild, the Ralph package choice, and specialized remote/container adapters remain follow-up implementation work.

## Amendment

**Date:** 2026-08-01

The migration is staged. The existing CLI is moved into `@prodigy/cli` early as a mechanical compatibility scaffold so the repository has a stable executable during core development. That scaffold is temporary: after `@prodigy/core` is usable, the CLI is rebuilt in place against core's public API and its duplicated legacy implementation is removed.
