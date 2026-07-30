import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";

const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
});
export type TextPart = typeof TextPart.Type;

export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown,
  providerExecuted: Schema.Boolean
});
export type ToolCallPart = typeof ToolCallPart.Type;

export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  isFailure: Schema.Boolean,
  result: Schema.Unknown
});
export type ToolResultPart = typeof ToolResultPart.Type;

export type MessagePart = TextPart | ToolCallPart | ToolResultPart;

export const SystemMessage = Schema.Struct({
  role: Schema.Literal("system"),
  content: Schema.String
});
export type SystemMessage = typeof SystemMessage.Type;

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(TextPart)])
});
export type UserMessage = typeof UserMessage.Type;

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([TextPart, ToolCallPart]))])
});
export type AssistantMessage = typeof AssistantMessage.Type;

export const ToolMessage = Schema.Struct({
  role: Schema.Literal("tool"),
  content: Schema.Array(ToolResultPart)
});
export type ToolMessage = typeof ToolMessage.Type;

export const Message = Schema.Union([SystemMessage, UserMessage, AssistantMessage, ToolMessage]);
export type Message = typeof Message.Type;

export const SessionSchema = Schema.Struct({
  id: SessionId,
  messages: Schema.mutable(Schema.Array(Message)),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString
});

export type Session = typeof SessionSchema.Type;

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  id: Schema.String
}) {}

export class SessionStorageError extends Schema.TaggedErrorClass<SessionStorageError>()("SessionStorageError", {
  operation: Schema.Literals(["create", "save", "load", "list", "delete"]),
  id: Schema.optional(Schema.String),
  cause: Schema.Defect()
}) {}

export type SessionError = SessionNotFound | SessionStorageError;

class SessionRepo extends Context.Service<
  SessionRepo,
  {
    readonly create: (systemPrompt?: string) => Effect.Effect<Session, SessionStorageError>;
    readonly save: (session: Session) => Effect.Effect<void, SessionStorageError>;
    readonly load: (id: string) => Effect.Effect<Session, SessionNotFound | SessionStorageError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<Pick<Session, "id" | "createdAt" | "updatedAt">>,
      SessionStorageError
    >;
    readonly delete: (id: string) => Effect.Effect<void, SessionStorageError>;
  }
>()("prodigy-coder/session/SessionRepo") {
  static readonly layer = (sessionDir: string) =>
    Layer.effect(
      SessionRepo,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const clock = yield* Clock.Clock;

        const ensureDir = Effect.gen(function* () {
          const exists = yield* fs.exists(sessionDir);
          if (!exists) {
            yield* fs.makeDirectory(sessionDir, { recursive: true });
          }
        });

        const sessionPath = (id: string) => `${sessionDir}/${id}.json`;

        const generateId = (): SessionId => {
          const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
          const bytes = new Uint8Array(8);
          crypto.getRandomValues(bytes);
          let id = "";
          for (let i = 0; i < 8; i++) {
            id += chars[bytes[i] % 36];
          }

          return SessionId.make(id);
        };

        const create = Effect.fnUntraced(
          function* (systemPrompt?: string) {
            yield* ensureDir;
            const now = yield* clock.currentTimeMillis;
            const nowDate = new Date(now);

            let id = generateId();
            let attempts = 0;
            while ((yield* fs.exists(sessionPath(id))) && attempts < 10) {
              id = generateId();
              attempts++;
            }

            const messages: Message[] = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];

            return {
              id,
              messages,
              createdAt: nowDate,
              updatedAt: nowDate
            };
          },
          (effect) => Effect.mapError(effect, (cause) => new SessionStorageError({ operation: "create", cause }))
        );

        const save = Effect.fnUntraced(
          function* (session: Session) {
            const now = yield* clock.currentTimeMillis;
            const updated = { ...session, updatedAt: new Date(now) };
            const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(SessionSchema))(updated);
            yield* fs.writeFileString(sessionPath(session.id), json);
          },
          (effect, session) =>
            effect.pipe(
              Effect.mapError((cause) => new SessionStorageError({ operation: "save", id: session.id, cause }))
            )
        );

        const load = Effect.fnUntraced(function* (id: string) {
          const content = yield* fs
            .readFileString(sessionPath(id))
            .pipe(
              Effect.mapError((e) =>
                e.reason._tag === "NotFound"
                  ? new SessionNotFound({ id })
                  : new SessionStorageError({ operation: "load", id, cause: e })
              )
            );
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SessionSchema))(content).pipe(
            Effect.mapError((cause) => new SessionStorageError({ operation: "load", id, cause }))
          );
        });

        const list = Effect.fnUntraced(
          function* () {
            yield* ensureDir;
            const entries = yield* fs.readDirectory(sessionDir);
            const jsonFiles = entries.filter((f) => f.endsWith(".json"));

            const sessions: { id: SessionId; createdAt: Date; updatedAt: Date }[] = [];

            for (const entry of jsonFiles) {
              const id = entry.replace(".json", "");
              // Skip sessions that were deleted between readDirectory and load (TOCTOU race).
              const result = yield* load(id).pipe(Effect.option);
              if (Option.isSome(result)) {
                sessions.push({
                  id: result.value.id,
                  createdAt: result.value.createdAt,
                  updatedAt: result.value.updatedAt
                });
              }
            }

            return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          },
          (effect) => Effect.mapError(effect, (cause) => new SessionStorageError({ operation: "list", cause }))
        );

        const deleteSession = Effect.fnUntraced(
          function* (id: string) {
            const path = sessionPath(id);
            const exists = yield* fs.exists(path);
            if (exists) {
              yield* fs.remove(path);
            }
          },
          (effect, id) =>
            effect.pipe(Effect.mapError((cause) => new SessionStorageError({ operation: "delete", id, cause })))
        );

        return { create, save, load, list, delete: deleteSession };
      })
    );
}

export { SessionRepo };
