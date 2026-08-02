# Branded Types in `@prodigy/core`

**Rule:** every branded identifier is a structural, compile-time brand built on `Schema.brand` — not a nominal class — and construction is encapsulated in the owning authority. Bypassing the type (casts, `as any`) is blocked by the linters (`.oxlintrc.json`: `typescript/consistent-type-assertions: never`, `no-explicit-any`, `no-ts-ignore`), so the brand is trusted.

## What this means

- **Representation:** the runtime value is a plain string or number. The brand exists only in the type system.
- **Mechanism:** a validating `Schema`, refined with `Schema.brand("Name")` as the last step. The underlying schema encodes the domain's invariants (charset, length, format), and `brand` adds the nominal tag on top — so the schema both *validates* and *types*. This is uniform across all brands, even ones never persisted (e.g. `RunId`).
- **Schema privacy:** the brand *schema* is a module-private const. Only the derived `type` is exported.

```ts
// capabilities/session.ts (private const, public type)
const SessionId = Schema.String.pipe(
  Schema.isPattern(/^[a-z0-9]{8}$/),     // 8 lowercase-alphanumeric chars
  Schema.brand("SessionId")
)
type SessionId = Schema.Schema.Type<typeof SessionId>
export type { SessionId }
```

The schema carries the validation, so decoding a value already enforces the format — no separate hand-rolled check:

- `Schema.String.pipe(Schema.isPattern(regex), Schema.brand("Name"))` — custom format (e.g. an 8-char lowercase-alphanumeric `SessionId`).
- `Schema.String.pipe(Schema.isUUID(7), Schema.brand("RunId"))` — a strict UUIDv7 `RunId`.
- `Schema.Natural.pipe(Schema.brand("SessionRevision"))` — a non-negative integer `SessionRevision`.

Validation is part of the schema — never duplicated in hand-rolled guards. If a format has no built-in check, add the constraint with `Schema.isPattern` rather than dropping it.

## Construction is encapsulated in the owning authority

There is **no public `.make`** for any brand. Each brand is produced only inside the piece of the system that legitimately owns its lifecycle:

| Brand | Schema (validation) | Produced by | Mechanism |
|---|---|---|---|
| `SessionId` | `Schema.String.pipe(Schema.isPattern(/^[a-z0-9]{8}$/), Schema.brand("SessionId"))` | `SessionStore.create` (memory adapter) | internal `generateSessionId` — 8-char lowercase-alphanumeric, an exact port of the CLI's `chars[bytes[i] % 36]` algorithm onto `Crypto.randomBytes(8)` |
| `RunId` | `Schema.String.pipe(Schema.isUUID(7), Schema.brand("RunId"))` | the run loop (`ProdigyAgent.run`) | internal `generateRunId` — `Crypto.randomUUIDv7` |
| `SessionRevision` | `Schema.Natural.pipe(Schema.brand("SessionRevision"))` | the store's CAS | incremented atomically on each successful `save`, never caller-supplied |

The generators are **internal module exports**: importable by adapters and the run loop, but never re-exported from the package root. Consumers receive branded values and name the types; they never construct them.

## Entropy comes from the `Crypto` service

All randomness flows through Effect's `Crypto` service (runtime-neutral, in `effect/Crypto`) — never a global `crypto` and never ad-hoc id generation. `@prodigy/core`'s modules are dependency-preserving: they carry `Crypto` in their `R` type, and the composition root / tests provide the platform layer (`BunCrypto.layer` from `@effect/platform-bun`, a devDependency of core).

## Tests: real Crypto, assert shape only

Id allocation is real randomness in tests — there is no scripted/deterministic id source. The validating schemas do the format checking: assert shape, format, and uniqueness, never exact values. Decoding the generated id against its schema (or matching its pattern) proves the invariant:

- a `SessionId` decodes against the `/^[a-z0-9]{8}$/` schema,
- a `RunId` decodes against `Schema.isUUID(7)`,
- two successive `create`/`run` calls yield distinct ids.

## Decoding persisted ids: only at the persistence boundary

A branded id read from storage (e.g. a session file) is decoded back to its branded type *only* at the persistence boundary — never spread across adapters, never re-branded ad hoc. The `decodeSessionId` helper is deferred with the file adapter (a future slice); the brand schema stays private until then.

## Applies to all brands

This convention covers the run-contract brands (`SessionId`, `RunId`, `SessionRevision`) and extends to the ticket-02 brands (`WorkspacePath`, `AbsolutePath`, `ContentRevision`) when those arrive. When a new branded value appears, ask: who owns it, how is it produced, and where does it get decoded?
