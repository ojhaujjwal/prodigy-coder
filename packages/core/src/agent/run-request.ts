import { Crypto, Effect, Schema } from "effect";
import { SessionId } from "../capabilities/session.ts";
import { PositiveInt, type PositiveInt as PositiveIntType } from "./agent-profile.ts";
import type { SessionId as SessionIdType } from "../capabilities/session.ts";
import { InvalidRunRequest } from "./agent-error.ts";

/** The `RunId` brand schema: a strict UUIDv7. */
const RunId = Schema.String.pipe(Schema.check(Schema.isUUID(7)), Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

/** The smallest request contract: one logical prompt plus explicit session identity. */
export type RunRequest = {
  readonly prompt: string;
  readonly sessionId?: SessionIdType;
  readonly maxTurns?: number;
};

const RunRequestShape = Schema.Struct({
  prompt: Schema.String,
  sessionId: Schema.optional(SessionId),
  // `maxTurns` is intentionally not refined at the struct level: a malformed
  // value must project to `invalid-max-turns` (not `empty-prompt`), so it is
  // decoded against the `PositiveInt` schema separately in `decodeRunRequest`.
  maxTurns: Schema.optional(Schema.Unknown)
});

type DecodedRunRequest = Schema.Schema.Type<typeof RunRequestShape>;

/**
 * Validate a `maxTurns` override against the profile's bounds before any
 * session or model work. Returns a canonical `InvalidRunRequest` failure when
 * the override is missing/malformed (`invalid-max-turns`) or outside the
 * profile's validated resource bounds (`out-of-bounds-override`).
 */
export const validateMaxTurnsOverride = (
  override: unknown,
  profileMaxTurns: PositiveIntType
): Effect.Effect<PositiveIntType, InvalidRunRequest> =>
  Schema.decodeUnknownEffect(PositiveInt)(override).pipe(
    Effect.mapError(() => new InvalidRunRequest({ reason: "invalid-max-turns" })),
    Effect.flatMap((value) =>
      value > profileMaxTurns
        ? Effect.fail(new InvalidRunRequest({ reason: "out-of-bounds-override" }))
        : Effect.succeed(value)
    )
  );

/**
 * Validate a run request at the lazy agent boundary. A malformed `maxTurns`
 * override projects to `invalid-max-turns`; an empty prompt projects to
 * `empty-prompt`.
 */
export const decodeRunRequest = (input: unknown): Effect.Effect<RunRequest, InvalidRunRequest> =>
  Effect.gen(function* () {
    const request: DecodedRunRequest = yield* Schema.decodeUnknownEffect(RunRequestShape)(input).pipe(
      Effect.mapError((cause) => new InvalidRunRequest({ reason: "empty-prompt", cause }))
    );
    if (request.prompt.trim().length === 0) {
      return yield* new InvalidRunRequest({ reason: "empty-prompt" });
    }
    const maxTurns =
      request.maxTurns === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(PositiveInt)(request.maxTurns).pipe(
            Effect.mapError(() => new InvalidRunRequest({ reason: "invalid-max-turns" }))
          );
    return {
      prompt: request.prompt,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(maxTurns === undefined ? {} : { maxTurns })
    };
  });

/** Allocate a fresh `RunId` from the `Crypto` service. */
export const generateRunId: Effect.Effect<RunId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
  return RunId.make(id);
});
