import { Crypto, Effect, Schema } from "effect";
import { SessionId } from "../capabilities/session.ts";
import { PositiveInt } from "./agent-profile.ts";
import { InvalidRunRequest } from "./agent-error.ts";

/** The `RunId` brand schema: a strict UUIDv7. */
const RunId = Schema.String.pipe(Schema.check(Schema.isUUID(7)), Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

export const RunRequest = Schema.Struct({
  prompt: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isPattern(/\S/))),
  sessionId: Schema.optional(SessionId),
  maxTurns: Schema.optional(PositiveInt)
});

export type RunRequest = Schema.Schema.Type<typeof RunRequest>;

/** The encoded representation accepted at the public run boundary. */
export type RunRequestInput = Schema.Codec.Encoded<typeof RunRequest>;

/**
 * Validate a run request at the lazy agent boundary. Any malformed field
 * (empty prompt, bad `sessionId`, bad `maxTurns`) fails the struct decode and
 * projects to `InvalidRunRequest`.
 */
export const decodeRunRequest = (input: RunRequestInput): Effect.Effect<RunRequest, InvalidRunRequest> =>
  Schema.decodeUnknownEffect(RunRequest)(input).pipe(Effect.mapError((cause) => new InvalidRunRequest({ cause })));

/** Allocate a fresh `RunId` from the `Crypto` service. */
export const generateRunId: Effect.Effect<RunId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
  return RunId.make(id);
});
