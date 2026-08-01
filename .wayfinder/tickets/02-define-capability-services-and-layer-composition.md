---
title: Define Capability Services and Layer Composition
type: wayfinder:grilling
status: closed
assignee: codex
resolution_date: 2026-08-01
parent: ../map.md
blocked_by: []
---

# Define Capability Services and Layer Composition

## Question

Which application-owned services should the core require—such as `Workspace`, `CommandExecutor`, `SessionStore`, `HumanInteraction`, and observability—and how should dependency-preserving Layers, production Layers, test Layers, and the `ManagedRuntime` convenience factory compose them?

## Resolution

**Date:** 2026-08-01

The capability model uses separate authority seams, with dependencies declared only by the modules that use them:

- `ProdigyAgent` requires `SessionStore` and the caller-provided `LanguageModel`/toolkit context.
- Built-in toolkit handlers require `Workspace` and/or `CommandExecutor` as needed.
- Interaction-enabled tools and authorization adapters require `HumanInteraction` only when selected.
- Observability uses Effect's built-in `Logger`, `Tracer`, and `Metrics` services; the core does not require a custom observability service.

`Workspace` and `CommandExecutor` are separate services. A convenience `SandboxLayer` may bundle their concrete Layers, but the service contracts remain separate so file access and process execution can have independent policy, least-privilege composition, implementations, tests, and failure models.

The core-facing workspace authority owns the complete built-in file-tool surface:

```ts
type WorkspacePath = Brand<string, "WorkspacePath"> // parsed, root-relative
type AbsolutePath = Brand<string, "AbsolutePath"> // adapter-only
type ContentRevision = Brand<string, "ContentRevision">

interface Workspace {
  readonly exists: (path: WorkspacePath) => Effect<boolean, WorkspaceLookupError>
  readonly read: (path: WorkspacePath) => Effect<string, WorkspaceLookupError>
  readonly write: (
    path: WorkspacePath,
    content: string,
    options?: { readonly expectedRevision?: ContentRevision }
  ) => Effect<ContentRevision, WorkspacePersistenceError>
  readonly replaceText: (
    path: WorkspacePath,
    oldText: string,
    newText: string,
    options?: { readonly expectedRevision?: ContentRevision }
  ) => Effect<ContentRevision, WorkspacePersistenceError>
  readonly grep: (request: GrepRequest) => Effect<ReadonlyArray<GrepMatch>, WorkspaceSearchError>
  readonly glob: (request: GlobRequest) => Effect<ReadonlyArray<WorkspacePath>, WorkspaceSearchError>
}

type WorkspaceError =
  | WorkspaceLookupError
  | WorkspacePersistenceError
  | WorkspaceSearchError
```

Workspace paths are parsed into a branded root-relative type. Absolute paths are a distinct adapter-only brand; path parsing rejects absolute paths, empty paths, and parent traversal. Workspace adapters enforce roots, permissions, output limits, and other sandbox policy. Mutations are atomic; `replaceText` requires exactly one match, and an optional expected revision detects lost updates. `exists` returns `false` for absence, and search operations return empty collections for no matches. Missing reads and edit conflicts are typed failures.

Workspace methods use cohesive error families rather than one error per method. Lookup operations (`exists`, `read`) use `WorkspaceLookupError`; mutations (`write`, `replaceText`) use `WorkspacePersistenceError`; and searches (`grep`, `glob`) use `WorkspaceSearchError`. `WorkspaceError` is the module-level union. Each family follows Effect's HTTP-client-style wrapper-plus-`reason` pattern, so callers can match the family tag first and then inspect precise reasons with safe context.

`CommandExecutor` accepts a structured request and returns a completion result:

```ts
type CommandRequest = {
  readonly argv: ReadonlyArray<string>
  readonly cwd?: WorkspacePath
  readonly environment?: Readonly<Record<string, string>>
  readonly timeout?: Duration
}

type CommandResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

interface CommandExecutor {
  readonly execute: (request: CommandRequest) => Effect<CommandResult, CommandExecuteError>
}

type CommandExecutorError = CommandExecuteError
```

Shell-string parsing belongs to a shell tool or adapter. A non-zero exit code is a normal `CommandResult`; `CommandExecutorError` wraps a grouped reason union for spawn, transport, timeout, cancellation, and output/resource-limit failures. Adapters may stream internally, but the core contract is completion-oriented; caller cancellation is Effect interruption.

`SessionStore` exposes only the run-time lifecycle needed by the agent and operates on domain values. Its errors are grouped by lookup versus persistence semantics:

```ts
interface SessionStore {
  readonly create: (initial: SessionInitial) => Effect<Session, SessionPersistenceError>
  readonly load: (id: SessionId) => Effect<Session, SessionLookupError>
  readonly save: (session: Session) => Effect<void, SessionPersistenceError>
}

type SessionError = SessionLookupError | SessionPersistenceError

// SessionLookupError.reason = SessionNotFound | SessionReadFailure | SessionDecodeFailure
// SessionPersistenceError.reason = SessionConflict | SessionEncodeFailure | SessionWriteFailure
```

The agent does not depend on persistence records, serialization, versioning, list operations, or delete operations. Administrative `list`/`delete` capabilities remain outside this contract. Checkpoint timing, concurrency, retention, and resume semantics are defined by [Define SessionStore Checkpoint Semantics](04-define-sessionstore-checkpoint-semantics.md).

`HumanInteraction` is a typed request/response channel, not a terminal prompt API:

```ts
interface HumanInteraction {
  readonly request: (
    input: InteractionRequest
  ) => Effect<InteractionResponse, HumanInteractionError>
}
```

Authorization policy remains separate from this channel. Interactive authorization may use `HumanInteraction`; automated policies do not need it. Adapter timeouts are typed interaction failures, while caller cancellation remains interruption. Human interaction is an optional Layer dependency.

Configuration such as agent profiles, prompts, turn limits, and governance is explicit typed data rather than an ambient configuration service. Provider construction and toolkit selection are caller-owned; the core depends on the provider-neutral `LanguageModel` and selected toolkit Layers. Execution safety remains in the Workspace and CommandExecutor adapters, not in approval policy.

Layer composition follows three levels:

1. Each service/application module exposes a dependency-preserving `layerNoDeps`.
2. Each concrete adapter exposes its own production Layer.
3. `makeApplicationLayer` composes caller-provided Layers; it does not silently grant local authorities.

The SDK also provides an explicit `localApplicationLayer` for the CLI, combining file-backed sessions with local Workspace and CommandExecutor adapters. Reusable test Layers use the same contracts (`MemoryWorkspace`, `TestCommandExecutor`, `MemorySessionStore`, and scripted `HumanInteraction`) instead of module mocks.

`makeManagedRuntime` returns the actual shared Effect `ManagedRuntime` built from the application Layer. It owns application resources for its lifetime and requires explicit disposal. Promise/async-iterator helpers are adapters over that runtime, not a second runtime model. The CLI owns Bun startup and supplies `BunServices`; local SDK adapters depend on portable Effect platform services such as `FileSystem`, `Path`, and `ChildProcessSpawner`.

This resolution supersedes the older architecture draft where its proposed service shapes differ; the wayfinder map and closed tickets are canonical.

## Amendment

**Date:** 2026-08-01

Error channels use cohesive families rather than one broad error per method or one error class per method. `Workspace` groups lookup, persistence, and search failures; `SessionStore` groups lookup and persistence failures. A module-level error such as `SessionError` or `WorkspaceError` is a plain union of those family errors. Each family carries a tagged `reason` union containing the precise failure kind and operation-safe detail. Single-operation services such as `CommandExecutor` use one wrapper with a `reason` union.

**Session checkpoint refinement:** The `SessionStore` port remains limited to runtime `create`, `load`, and `save`, but `save` is conditional on an expected session revision and returns the committed revision. The complete checkpoint, atomicity, conflict, interruption, and serialization guarantees are defined by [Define SessionStore Checkpoint Semantics](04-define-sessionstore-checkpoint-semantics.md).
