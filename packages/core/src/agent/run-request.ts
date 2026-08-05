import { Crypto, Effect, Schema } from "effect";
import { SessionId } from "../capabilities/session.ts";
import type { SessionId as SessionIdType } from "../capabilities/session.ts";
import { InvalidRunRequest } from "./agent-error.ts";

/** The `RunId` brand schema: a strict UUIDv7. */
const RunId = Schema.String.pipe(Schema.check(Schema.isUUID(7)), Schema.brand("RunId"));
export type RunId = Schema.Schema.Type<typeof RunId>;

/** The smallest request contract: one logical prompt plus explicit session identity. */
export type RunRequest = {
  readonly prompt: string;
  readonly sessionId?: SessionIdType;
};

const RunRequestShape = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  sessionId: Schema.optional(SessionId)
});

type DecodedRunRequest = Schema.Schema.Type<typeof RunRequestShape>;

/** Validate a run request at the lazy agent boundary. */
export const decodeRunRequest = (input: unknown): Effect.Effect<RunRequest, InvalidRunRequest> =>
  Schema.decodeUnknownEffect(RunRequestShape)(input).pipe(
    Effect.mapError((cause) => new InvalidRunRequest({ reason: "missing-prompt", cause })),
    Effect.flatMap((request: DecodedRunRequest) => {
      if (request.prompt === undefined) {
        return Effect.fail(new InvalidRunRequest({ reason: "missing-prompt" }));
      }
      if (request.prompt.trim().length === 0) {
        return Effect.fail(new InvalidRunRequest({ reason: "empty-prompt" }));
      }
      return request.sessionId === undefined
        ? Effect.succeed({ prompt: request.prompt })
        : Effect.succeed({ prompt: request.prompt, sessionId: request.sessionId });
    })
  );

/** Allocate a fresh `RunId` from the `Crypto` service. */
export const generateRunId: Effect.Effect<RunId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
  return RunId.make(id);
});
