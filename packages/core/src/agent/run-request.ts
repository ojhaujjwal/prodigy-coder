import { Crypto, Effect, Schema } from "effect";
import type { SessionId } from "../capabilities/session.ts";

/**
 * The `RunId` brand schema: a strict UUIDv7.
 *
 * Internal to the run's authority — construction happens only through
 * {@link generateRunId}. The schema itself is never re-exported from the
 * package root; consumers only name the `RunId` type.
 */
const RunId = Schema.String.pipe(Schema.check(Schema.isUUID(7)), Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

/** The smallest request contract: one logical prompt plus explicit session identity. */
export type RunRequest = {
  readonly prompt: string;
  readonly sessionId?: SessionId;
};

/**
 * Allocate a fresh `RunId` from the `Crypto` service.
 *
 * Internal module export — importable by the run loop (and tests) but never
 * re-exported from the package root. Freshness is real randomness; callers
 * assert shape/format/uniqueness, never exact values.
 */
export const generateRunId: Effect.Effect<RunId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
  return RunId.make(id);
});
