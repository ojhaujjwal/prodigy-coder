import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";

export const Message = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
  content: Schema.String
});
export type Message = typeof Message.Type;

export const SessionSchema = Schema.Struct({
  id: Schema.String,
  messages: Schema.mutable(Schema.Array(Message)),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString
});
export type Session = typeof SessionSchema.Type;

const SESSION_DIR: string = ".prodigy-coder/sessions";

class SessionRepo extends Context.Service<
  SessionRepo,
  {
    readonly create: (systemPrompt?: string) => Effect.Effect<Session, never>;
    readonly save: (session: Session) => Effect.Effect<void, unknown, never>;
    readonly load: (id: string) => Effect.Effect<Session, unknown, never>;
    readonly list: () => Effect.Effect<ReadonlyArray<{ id: string; createdAt: Date; updatedAt: Date }>, unknown, never>;
    readonly delete: (id: string) => Effect.Effect<void, unknown, never>;
  }
>()("SessionRepo") {
  static readonly layer = Layer.effect(
    SessionRepo,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const clock = yield* Clock.Clock;

      const ensureDir = Effect.gen(function* () {
        const exists = yield* fs.exists(SESSION_DIR);
        if (!exists) {
          yield* fs.makeDirectory(SESSION_DIR, { recursive: true });
        }
      });

      const sessionPath = (id: string) => `${SESSION_DIR}/${id}.json`;

      const create = (systemPrompt?: string) =>
        Effect.gen(function* () {
          yield* ensureDir.pipe(Effect.orDie);
          const id = crypto.randomUUID();
          const now = yield* clock.currentTimeMillis;
          const nowDate = new Date(now);

          const messages: Message[] = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];

          return {
            id,
            messages,
            createdAt: nowDate,
            updatedAt: nowDate
          };
        });

      const save = Effect.fnUntraced(function* (session: Session) {
        const now = yield* clock.currentTimeMillis;
        const updated = { ...session, updatedAt: new Date(now) };
        const json = Schema.encodeUnknownSync(Schema.fromJsonString(SessionSchema))(updated);
        yield* fs.writeFileString(sessionPath(session.id), json);
      });

      const load = Effect.fnUntraced(function* (id: string) {
        const content = yield* fs.readFileString(sessionPath(id));
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SessionSchema))(content);
      });

      const list = Effect.fnUntraced(function* () {
        yield* ensureDir;
        const entries = yield* fs.readDirectory(SESSION_DIR);
        const jsonFiles = entries.filter((f) => f.endsWith(".json"));

        const sessions: { id: string; createdAt: Date; updatedAt: Date }[] = [];

        for (const entry of jsonFiles) {
          const id = entry.replace(".json", "");
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
      });

      const deleteSession = Effect.fnUntraced(function* (id: string) {
        const path = sessionPath(id);
        const exists = yield* fs.exists(path);
        if (exists) {
          yield* fs.remove(path);
        }
      });

      return { create, save, load, list, delete: deleteSession };
    })
  );
}

export const createSession = (systemPrompt?: string) =>
  Effect.service(SessionRepo).pipe(Effect.flatMap((repo) => repo.create(systemPrompt)));

export const saveSession = (session: Session) =>
  Effect.service(SessionRepo).pipe(Effect.flatMap((repo) => repo.save(session)));

export const loadSession = (id: string) => Effect.service(SessionRepo).pipe(Effect.flatMap((repo) => repo.load(id)));

export const listSessions = () => Effect.service(SessionRepo).pipe(Effect.flatMap((repo) => repo.list()));

export const deleteSession = (id: string) =>
  Effect.service(SessionRepo).pipe(Effect.flatMap((repo) => repo.delete(id)));

export { SessionRepo };
