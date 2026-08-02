---
title: Define the Core SessionStore Port and In-Memory Adapter
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 12-set-up-the-core-test-harness-and-testing-guidelines.md
---

# Define the Core SessionStore Port and In-Memory Adapter

## Summary

Implement ticket 04's `SessionStore` as a foundation: the domain `Session` transcript model, `SessionId`/`SessionRevision` brands, the `create`/`load`/`save` port with optimistic compare-and-set, and an in-memory adapter. A developer can create, load, and conditionally save sessions and observe lost-update conflicts without a model or run. The file-backed adapter is deliberately deferred (it belongs with the CLI/local package work, not this slice).

## Context / Current State

The CLI's `SessionRepo` (`packages/cli/src/session.ts`) is the behavioral reference: schema-based encode/decode, `Date` timestamps, file persistence, typed `SessionNotFound`/`SessionStorageError`. It has no revision/CAS and no checkpoint semantics. Ticket 04 refines the runtime port to `create`/`load`/`save` with an optimistic revision, and this ticket implements that port (memory adapter only) inside `@prodigy/core`.

## Goals

- The runtime `SessionStore` port from ticket 04, implemented over a domain `Session` value.
- In-memory adapter with atomic compare-and-set for its process lifetime.
- Typed lookup and persistence failures, never thrown or silently merged.

## Non-Goals

- File/database/remote adapters, `PersistedSession` envelope, and format migration (deferred).
- Administrative `list`/`delete`/retention (out of the runtime port, per ticket 04).
- Any model or agent behavior (slice 14+).

## Invariants

- `create` returns a transient snapshot at revision 0; the first successful `save` creates the durable record.
- `save` succeeds only when `expectedRevision` equals the current revision, then atomically advances to a new revision; mismatch is a `SessionConflict`.
- A successful `save` makes one complete snapshot visible at one new revision; a failed save leaves the previous revision loadable.
- A missing session loads as `SessionNotFound`; nothing silently replaces or merges competing transcripts.

## Design Constraints

- Adapter semantics are the same logical guarantee regardless of mechanism (ticket 04); the memory adapter preserves CAS for its process lifetime without a crash-durability claim.
- Runtime-neutral: no file/process/platform services in the port or memory adapter.
- Built-in Effect services are yielded where real authority exists: `Clock` for `createdAt`/`updatedAt`, `Crypto` for a fresh `SessionId` (via the internal `generateSessionId`). Both are portable and test-controllable — the adapter never calls `new Date()` or ad-hoc id generation.
- Branded types follow the shared convention (`specs/guides/branded-types.md`): `Schema.brand` (structural, compile-time), construction only inside the owning authority, brand schema module-private (only the `type` exported), no public `.make`.

## Types, Interfaces, and APIs

```ts
const SessionId = Schema.String.pipe(
  Schema.isPattern(/^[a-z0-9]{8}$/),   // 8 lowercase-alphanumeric chars
  Schema.brand("SessionId")
)                                        // schema private, type exported
type SessionId = Schema.Schema.Type<typeof SessionId>             // branded string, ticket 01/04
const SessionRevision = Schema.Natural.pipe(Schema.brand("SessionRevision"))   // non-negative integer
type SessionRevision = Schema.Schema.Type<typeof SessionRevision>
type Session = { id: SessionId; messages: Message[]; createdAt: Date; updatedAt: Date }  // domain transcript
type SessionInitial = { systemPrompt?: string }   // create always allocates the SessionId (no supplied-id branch)
type SessionSnapshot = { session: Session; revision: SessionRevision }
type SessionCheckpoint = { session: Session; expectedRevision: SessionRevision }

interface SessionStore {
  readonly create: (initial: SessionInitial) => Effect<SessionSnapshot, SessionPersistenceError>
  readonly load: (id: SessionId) => Effect<SessionSnapshot, SessionLookupError>
  readonly save: (checkpoint: SessionCheckpoint) => Effect<SessionSnapshot, SessionPersistenceError>
}

type SessionError = SessionLookupError | SessionPersistenceError
// SessionLookupError.reason  = SessionNotFound | SessionReadFailure | SessionDecodeFailure
// SessionPersistenceError.reason = SessionConflict | SessionEncodeFailure | SessionWriteFailure

// internal module export (importable by adapters, NOT re-exported from the package root):
const generateSessionId: Effect.Effect<SessionId, never, Crypto.Crypto>
```

The brand schemas carry the validation (see `specs/guides/branded-types.md`): `SessionId` enforces its 8-char lowercase-alphanumeric format via `Schema.isPattern`, and `SessionRevision` is a `Schema.Natural`. Decoding against these schemas is the only way a value becomes a `SessionId`/`SessionRevision` — there is no separate hand-rolled guard.

`SessionLookupError`/`SessionPersistenceError` use the Effect-style wrapper-plus-`reason` pattern from ticket 02's amendment so callers match the family tag first, then the precise reason.

## Seams, Boundaries, and Adapters

- **Port**: `SessionStore` (core-owned authority). The agent (slice 14+) depends only on this interface.
- **Adapter**: `MemorySessionStore` — `Ref`/`Map`-backed, CAS in one critical section. No file/network.
- **Authority seams inside the adapter**: `Clock` (timestamps) and `Crypto` (fresh `SessionId` via `generateSessionId`) are yielded from context in `make`, keeping allocation testable (install the real `Crypto` layer; assert shape/uniqueness, never exact values).
- `generateSessionId` is an internal module export in `session.ts`; the brand schema itself stays module-private (only the `type` is exported).
- Decode of persisted ids happens only at the persistence boundary: a `decodeSessionId` helper is deferred with the file adapter (not implemented in this slice).
- The domain `Session` message model follows the existing `packages/cli/src/session.ts` part shapes (text / tool-call / tool-result) so the CLI scaffold stays the migration reference; serialization is out of scope here.

## Call Stacks and Data Flow

```txt
create(initial)
  -> allocate SessionId via generateSessionId (Crypto.randomBytes -> chars[bytes[i] % 36], 8 chars)
  -> build Session { messages: [system?] , createdAt, updatedAt }
  -> snapshot at revision 0        // transient, not yet durable
  -> SessionSnapshot

save({ session, expectedRevision })
  -> compare expectedRevision == currentRevision
     mismatch  -> fail SessionPersistenceError{ reason: SessionConflict }
     match     -> store session, advance revision -> SessionSnapshot

load(id)
  -> lookup by id
     absent  -> fail SessionLookupError{ reason: SessionNotFound }
     present -> SessionSnapshot
```

## Files to Add / Change / Delete

- Add `packages/core/src/capabilities/session.ts` — `Session`, `SessionInitial`, `SessionSnapshot`, `SessionCheckpoint`, message part types, plus the module-private `SessionId`/`SessionRevision` brand schemas (types exported) and the internal `generateSessionId`.
- Add `packages/core/src/capabilities/session-store.ts` — the `SessionStore` service/port and the `SessionLookupError`/`SessionPersistenceError` families.
- Add `packages/core/src/capabilities/memory-session-store.ts` — `MemorySessionStore` implementation + its dependency-preserving `layerNoDeps`/`layer` (requirements `Crypto | Clock`), built with `Layer.effect` over a `Ref`. No closed `layer` in core — platform `Crypto` lives in `@effect/platform-bun` (composition root / tests install it).
- Add `packages/core/src/capabilities/__integration__/session-store.integration.test.ts` — create/load/save and conflict paths through real Layers.
- Add `packages/core/src/capabilities/__integration__/helpers.ts` additions: a `createTestSession`-style factory (or extend the harness helpers).
- Change none. Delete none. (Public root re-export is slice 19.)

## RGR TDD Test Plan

Vertical red-green-refactor slices, integration-first through the port with the memory adapter installed as a Layer:

- R1: **create** — red: `create()` returns a rev-0 snapshot with an empty (or system-seeded) transcript and a fresh `SessionId`. Implement `Session`/`SessionId`/`SessionRevision` + `create`. The `SessionId` is generated by the real `Crypto` layer; assert shape/format/uniqueness, never exact values.
- R2: **save commits and advances** — red: `save(expectedRevision)` commits, returns the new snapshot with an incremented revision, and subsequent `load` returns it. Implement CAS `save`.
- R3: **conflict** — red: `save` with a stale `expectedRevision` fails with `SessionPersistenceError`/`SessionConflict` and leaves the prior revision loadable. Implement the mismatch branch.
- R4: **load missing** — red: `load` of an unknown id fails with `SessionLookupError`/`SessionNotFound`.
- R5 (unit, edge): the CAS branch — compare/mismatch discrimination — is reachable via integration (R3); keep a unit test only for pure branches that are impractical through the stream (e.g. the `SessionId` shape / charset) per the guide.

## Risks and Open Questions

- ~~Whether `SessionInitial` should accept a supplied `sessionId`~~ **Resolved (2026-08-02):** `SessionInitial` is `{ systemPrompt?: string }` only — `create` always allocates the `SessionId` (construction is encapsulated in the store; a caller reaches an existing session via `load`, never by supplying an id).
- The exact `Message` part shapes: reuse the CLI scaffold's shapes verbatim to stay a faithful migration reference.
- `decodeSessionId` (decoding a persisted id at the persistence boundary) is deferred with the file adapter; the brand schema stays private. The pattern is recorded in `specs/guides/branded-types.md`.

## Acceptance criteria

- [ ] `SessionId`, the domain `Session` model, and `SessionRevision` are exported types from core modules; `SessionId` is `Schema.String.pipe(Schema.brand("SessionId"))` and `SessionRevision` is `Schema.Int.pipe(Schema.brand("SessionRevision"))` — schemas private, types exported, no public `.make` (see `specs/guides/branded-types.md`).
- [ ] The `SessionStore` port exposes `create`/`load`/`save` with the ticket-04 signatures (save takes an expected revision and returns the new snapshot).
- [ ] An in-memory adapter implements the port with atomic compare-and-set semantics for its process lifetime.
- [ ] A missing session loads as `SessionNotFound`; a stale save fails as `SessionConflict`; both are typed failures, never thrown or silently merged.
- [ ] Integration tests exercise create/load/save round-trips and the conflict path through the public store with real Layers; unit tests are limited to hard-to-cover edge branches per the testing guide `specs/guides/testing-core-integration.md`.
- [ ] `bun run test --run` in `packages/core` passes.

## Blocked by

12-set-up-the-core-test-harness-and-testing-guidelines.md — must complete first.
