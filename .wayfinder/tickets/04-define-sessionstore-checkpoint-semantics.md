---
title: Define SessionStore Checkpoint Semantics
type: wayfinder:grilling
status: closed
parent: ../map.md
blocked_by: []
assignee: Ujjwal Ojha
resolution_date: 2026-08-01
---

# Define SessionStore Checkpoint Semantics

## Question

What does `SessionStore` guarantee across file, memory, database, and remote adapters? Define session lifecycle, checkpoint timing, concurrent-run behavior, interrupted runs, serialization/versioning, and how the agent returns or resumes state.

## Resolution

**Date:** 2026-08-01

`SessionStore` is a replaceable persistence authority for committed conversation snapshots. It does not become a distributed lock manager, run registry, transaction coordinator, or retention service. The existing `Session` model remains the domain transcript: its messages and timestamps are preserved, while storage revision and wire-format version stay outside that domain value.

### Port shape

The earlier capability decision remains correct that the runtime contract is limited to create/load/save. Its save operation is refined to use optimistic compare-and-set:

```ts
type SessionRevision = Brand<number, "SessionRevision">

type SessionSnapshot = {
  readonly session: Session
  readonly revision: SessionRevision
}

type SessionCheckpoint = {
  readonly session: Session
  readonly expectedRevision: SessionRevision
}

interface SessionStore {
  readonly create: (initial: SessionInitial) => Effect<SessionSnapshot, SessionPersistenceError>
  readonly load: (id: SessionId) => Effect<SessionSnapshot, SessionLookupError>
  readonly save: (checkpoint: SessionCheckpoint) => Effect<SessionSnapshot, SessionPersistenceError>
}
```

`create` returns a transient snapshot at revision zero. The first successful `save` creates the durable record and advances the revision. `load` returns the committed session and its revision. `save` succeeds only when `expectedRevision` is the current revision, then atomically commits the complete next snapshot and returns its new revision. A mismatch is `SessionPersistenceError` with a `SessionConflict` reason; adapters never merge competing transcripts or retry on the caller's behalf.

This is an API-level refinement of [Define Capability Services and Layer Composition](02-define-capability-services-and-layer-composition.md), not a new persistence authority. Administrative `list`, `delete`, and retention remain outside the runtime `SessionStore` port.

### Lifecycle and checkpoint boundaries

1. A run with no session identity creates a transient session. A supplied identity is loaded explicitly; `SessionNotFound` never causes fallback to a new session.
2. The agent prepares the initial transcript, preserving the existing system-prompt behavior, appends the supplied user prompt, and saves that snapshot before the first model request.
3. Each model iteration accumulates streamed deltas, assistant content, tool calls, and tool results in memory. After the iteration has completed, the agent appends the complete assistant/tool exchange and saves one checkpoint before requesting another model turn.
4. No streamed delta, incomplete assistant message, or partial tool exchange is a durable checkpoint. A checkpoint is the latest complete transcript boundary, even when the next model turn is still required.
5. The agent emits `run-ended` only after the final checkpoint is accepted. A checkpoint failure is surfaced as the typed session persistence failure; it cannot produce a successful terminal result. Already-emitted progress events are not retracted.

The existing `SessionRepo.save` whole-document serialization is the implementation starting point. The migration should add revision-aware checkpointing and preserve its schema-parsed messages rather than introduce an event-sourced rewrite.

### Concurrency and interruption

The v1 guarantee is lost-update prevention, not exclusive session ownership. Multiple runs may read the same session, but each checkpoint is conditional on the revision it loaded. The first checkpoint at a revision wins; a later checkpoint receives `SessionConflict` and stops that run. There is no lease, heartbeat, fencing token, automatic merge, rollback, or automatic retry. A caller that requires one active run per session must enforce that policy outside this port.

If a run is interrupted or fails before its next checkpoint, the store retains the previous committed revision. Effect interruption remains interruption: it emits no `run-ended` event and is not converted into an `AgentError`. A tool or command may have produced an external side effect before the checkpoint failed; the store provides no rollback or cross-authority transaction. Retry and recovery are caller policy, with at-least-once effects where a caller chooses to retry.

Continuation is explicit and fresh. A caller supplies the same `SessionId` to a new `ProdigyAgent.run` invocation with a new prompt; there is no `SessionStore.resume`, public run handle, pending-run record, or automatic replay in v1. `AgentResult` continues to return terminal metadata, including `sessionId`, rather than duplicating the transcript or storage revision.

### Persistence and serialization

Every adapter exposes the same logical guarantee: a successful save makes one complete snapshot visible at one new revision, and a failed save leaves the previous revision loadable. The mechanism is adapter-owned and minimal—temporary-file-plus-atomic-replace for files, a database transaction/conditional update for databases, and an acknowledgement after the remote server commits. An in-memory adapter preserves atomic compare-and-set behavior for its process lifetime but makes no crash-durability claim.

Persisted records use a versioned envelope distinct from the domain session and concurrency revision:

```ts
type PersistedSession = {
  readonly formatVersion: number
  readonly revision: number
  readonly session: SessionRecord
}
```

Adapters parse untrusted records at their boundary, migrate supported older `formatVersion` values into the current `Session`, and return a typed decode failure for malformed or unsupported newer records. They never silently drop fields or treat a format version as a concurrency revision. The file adapter may continue using Effect Schema and `DateFromString` for its `SessionRecord` codec; database and remote adapters translate their own records into the same domain snapshot.

### Call-stack guarantee

```txt
ProdigyAgent.run(request)
  -> create or load SessionSnapshot
  -> append user message
  -> SessionStore.save(expectedRevision)       // prompt checkpoint
  -> LanguageModel / toolkit execution
  -> append complete assistant + tool exchange
  -> SessionStore.save(expectedRevision)       // turn checkpoint
  -> repeat or produce AgentResult
  -> run-ended only after final save succeeds
```

The implementation route is therefore an incremental generalization of `src/session.ts`: retain schema-based encode/decode, `Clock`-controlled timestamps, typed lookup/persistence errors, and adapter-specific file mechanics; add a snapshot revision, conditional save, atomic replacement, and the format envelope. Retention policy and administrative lifecycle remain map-level follow-up work.
