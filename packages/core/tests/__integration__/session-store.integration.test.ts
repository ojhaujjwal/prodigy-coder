import { describe, expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { layer as fileStoreLayer } from "../../src/capabilities/file-session-store.ts";
import { layerNoDeps as memoryStoreLayer } from "../../src/capabilities/memory-session-store.ts";
import { SessionLookupError, SessionPersistenceError, SessionStore } from "../../src/capabilities/session-store.ts";
import {
  Session,
  SessionRevision,
  type Message,
  type Session as SessionType,
  type SessionId
} from "../../src/capabilities/session.ts";
import { createTestSession, platformLayer } from "./helpers.ts";

const memoryLayer = Layer.provideMerge(memoryStoreLayer, BunCrypto.layer);

layer(memoryLayer)("MemorySessionStore", (it) => {
  describe("create", () => {
    it.effect("returns a revision-0 snapshot with a fresh well-formed SessionId", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const snapshot = yield* store.create({});

        expect(snapshot.revision).toBe(0);
        expect(snapshot.session.id).toMatch(/^[a-z0-9]{8}$/);
        expect(snapshot.session.messages).toEqual([]);
        expect(DateTime.isUtc(snapshot.session.createdAt)).toBe(true);
        expect(DateTime.isUtc(snapshot.session.updatedAt)).toBe(true);
      })
    );

    it.effect("allocates distinct ids for successive creates", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const first = yield* store.create({});
        const second = yield* store.create({});

        expect(first.session.id).not.toBe(second.session.id);
      })
    );

    it.effect("seeds the transcript with a system message when a systemPrompt is given", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const snapshot = yield* store.create({ systemPrompt: "You are a helpful assistant" });

        expect(snapshot.session.messages).toEqual([{ role: "system", content: "You are a helpful assistant" }]);
      })
    );
  });

  describe("save and load", () => {
    it.effect("save commits the transcript and advances the revision; load returns it", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const created = yield* store.create({});
        const params = { nested: { values: [1] } };
        const messages: Message[] = [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: [{ type: "tool-call", id: "call-1", name: "echo", params, providerExecuted: false }]
          }
        ];
        const session: SessionType = { ...created.session, messages };

        const saved = yield* store.save({ session, expectedRevision: created.revision });
        messages.push({ role: "user", content: "Caller mutation" });
        params.nested.values.push(2);

        expect(saved.revision).toBe(1);
        expect(saved.session.messages).toEqual([
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                id: "call-1",
                name: "echo",
                params: { nested: { values: [1] } },
                providerExecuted: false
              }
            ]
          }
        ]);

        const loaded = yield* store.load(created.session.id);
        expect(loaded.revision).toBe(1);
        expect(loaded.session.messages).toEqual(saved.session.messages);
      })
    );

    it.effect("save refreshes updatedAt and keeps createdAt stable", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const created = yield* store.create({});

        const saved = yield* store.save({ session: created.session, expectedRevision: created.revision });

        expect(saved.session.createdAt).toEqual(created.session.createdAt);
        expect(saved.session.updatedAt.epochMilliseconds).toBeGreaterThanOrEqual(
          created.session.updatedAt.epochMilliseconds
        );
      })
    );

    it.effect("a stale expectedRevision fails as SessionConflict and leaves the prior revision loadable", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const created = yield* store.create({});
        yield* store.save({ session: created.session, expectedRevision: created.revision });

        const failure = yield* store
          .save({ session: created.session, expectedRevision: created.revision })
          .pipe(Effect.flip);

        expect(failure).toBeInstanceOf(SessionPersistenceError);
        expect(failure.reason._tag).toBe("SessionConflict");

        const loaded = yield* store.load(created.session.id);
        expect(loaded.revision).toBe(1);
        expect(loaded.session.messages).toEqual([]);
      })
    );
  });

  describe("load", () => {
    it.effect("load of an unknown id fails as SessionLookupError/SessionNotFound", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const unknown = createTestSession("00000000");

        const failure = yield* store.load(unknown.id).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(SessionLookupError);
        expect(failure.reason._tag).toBe("SessionNotFound");
      })
    );
  });
});

const TEST_SESSION_DIR = "/tmp/.prodigy-core/test-sessions";

const fileLayer = fileStoreLayer(TEST_SESSION_DIR).pipe(Layer.provideMerge(platformLayer));

const cleanupSessions = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(TEST_SESSION_DIR);
    if (exists) {
      yield* fs.remove(TEST_SESSION_DIR, { recursive: true });
    }
    yield* fs.makeDirectory(TEST_SESSION_DIR, { recursive: true });
  });

layer(fileLayer)("FileSessionStore", (it) => {
  describe("create", () => {
    it.effect("returns a revision-0 snapshot with a fresh well-formed SessionId and writes no file", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;
        const fs = yield* FileSystem.FileSystem;

        const snapshot = yield* store.create({});

        expect(snapshot.revision).toBe(0);
        expect(snapshot.session.id).toMatch(/^[a-z0-9]{8}$/);
        expect(snapshot.session.messages).toEqual([]);
        expect(yield* fs.exists(`${TEST_SESSION_DIR}/${snapshot.session.id}.json`)).toBe(false);
      })
    );

    it.effect("seeds the transcript with a system message and allocates distinct ids", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;

        const first = yield* store.create({ systemPrompt: "You are a helpful assistant" });
        const second = yield* store.create({});

        expect(first.session.messages).toEqual([{ role: "system", content: "You are a helpful assistant" }]);
        expect(first.session.id).not.toBe(second.session.id);
      })
    );
  });

  describe("save and load", () => {
    it.effect("save writes a version-1 envelope and load round-trips it", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;
        const fs = yield* FileSystem.FileSystem;

        const created = yield* store.create({});
        const session: SessionType = {
          ...created.session,
          messages: [
            { role: "user", content: "Hello" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  id: "call-1",
                  name: "echo",
                  params: { nested: { values: [1, true, null] } },
                  providerExecuted: false
                }
              ]
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  id: "call-1",
                  name: "echo",
                  isFailure: false,
                  result: { nested: [{ value: "ok" }, { value: "done" }] }
                }
              ]
            }
          ]
        };

        const saved = yield* store.save({ session, expectedRevision: created.revision });
        expect(saved.revision).toBe(1);

        const entries = yield* fs.readDirectory(TEST_SESSION_DIR);
        expect(entries).toEqual([`${created.session.id}.json`]);

        const raw = yield* fs.readFileString(`${TEST_SESSION_DIR}/${created.session.id}.json`);
        const persisted = Schema.decodeUnknownSync(
          Schema.Struct({ formatVersion: Schema.Number, revision: SessionRevision, session: Session })
        )(JSON.parse(raw));
        expect(persisted.formatVersion).toBe(1);
        expect(persisted.revision).toBe(1);
        expect(persisted.session.id).toBe(created.session.id);
        expect(persisted.session.createdAt).toEqual(created.session.createdAt);
        expect(persisted.session.messages).toEqual(session.messages);

        const loaded = yield* store.load(created.session.id);
        expect(loaded.revision).toBe(1);
        expect(loaded.session.messages).toEqual(session.messages);
      })
    );

    it.effect("save refreshes updatedAt, keeps createdAt, and increments the revision", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;

        const created = yield* store.create({});
        const first = yield* store.save({ session: created.session, expectedRevision: created.revision });
        const second = yield* store.save({ session: first.session, expectedRevision: first.revision });

        expect(second.revision).toBe(2);
        expect(second.session.createdAt).toEqual(created.session.createdAt);
        expect(second.session.updatedAt.epochMilliseconds).toBeGreaterThanOrEqual(
          created.session.updatedAt.epochMilliseconds
        );
      })
    );

    it.effect("a stale expectedRevision fails as SessionConflict and leaves the prior revision loadable", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;

        const created = yield* store.create({});
        yield* store.save({ session: created.session, expectedRevision: created.revision });

        const failure = yield* store
          .save({ session: created.session, expectedRevision: created.revision })
          .pipe(Effect.flip);

        expect(failure).toBeInstanceOf(SessionPersistenceError);
        expect(failure.reason._tag).toBe("SessionConflict");

        const loaded = yield* store.load(created.session.id);
        expect(loaded.revision).toBe(1);
        expect(loaded.session.messages).toEqual([]);
      })
    );
  });

  describe("load failures", () => {
    it.effect("load of an unknown id fails as SessionLookupError/SessionNotFound", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;
        const unknown = createTestSession("00000000");

        const failure = yield* store.load(unknown.id).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(SessionLookupError);
        expect(failure.reason._tag).toBe("SessionNotFound");
      })
    );

    it.effect("load of a corrupted JSON file fails as SessionDecodeFailure", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;
        const fs = yield* FileSystem.FileSystem;
        const unknown = createTestSession("11111111");

        yield* fs.writeFileString(`${TEST_SESSION_DIR}/${unknown.id}.json`, "not valid json");

        const failure = yield* store.load(unknown.id).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(SessionLookupError);
        expect(failure.reason._tag).toBe("SessionDecodeFailure");
      })
    );

    it.effect("load of an unsupported format version fails as SessionDecodeFailure", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;
        const fs = yield* FileSystem.FileSystem;
        const unknown = createTestSession("22222222");
        const envelope = JSON.stringify({
          formatVersion: 99,
          revision: 1,
          session: {
            id: unknown.id,
            messages: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        });

        yield* fs.writeFileString(`${TEST_SESSION_DIR}/${unknown.id}.json`, envelope);

        const failure = yield* store.load(unknown.id).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(SessionLookupError);
        expect(failure.reason._tag).toBe("SessionDecodeFailure");
      })
    );

    it.effect("load fails as SessionDecodeFailure when the stored id mismatches the filename", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;
        const fs = yield* FileSystem.FileSystem;
        const unknown = createTestSession("33333333");
        const envelope = JSON.stringify({
          formatVersion: 1,
          revision: 1,
          session: {
            id: "99999999",
            messages: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        });

        yield* fs.writeFileString(`${TEST_SESSION_DIR}/${unknown.id}.json`, envelope);

        const failure = yield* store.load(unknown.id).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(SessionLookupError);
        expect(failure.reason._tag).toBe("SessionDecodeFailure");
      })
    );
  });

  describe("save failures", () => {
    it.effect("save over a corrupted existing file fails as SessionPersistenceError/SessionDecodeFailure", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;
        const fs = yield* FileSystem.FileSystem;

        const created = yield* store.create({});
        yield* store.save({ session: created.session, expectedRevision: created.revision });
        yield* fs.writeFileString(`${TEST_SESSION_DIR}/${created.session.id}.json`, "not valid json");

        const failure = yield* store
          .save({ session: created.session, expectedRevision: created.revision })
          .pipe(Effect.flip);

        expect(failure).toBeInstanceOf(SessionPersistenceError);
        expect(failure.reason._tag).toBe("SessionDecodeFailure");
      })
    );
  });
});

let persistedId: Option.Option<SessionId> = Option.none();

layer(fileLayer)("a fresh FileSessionStore over the same directory", (it) => {
  it.effect("persists a revision-1 session for a later store instance", () =>
    Effect.gen(function* () {
      yield* cleanupSessions();
      const store = yield* SessionStore;
      const created = yield* store.create({});
      const session: SessionType = { ...created.session, messages: [{ role: "user", content: "Hello" }] };
      const saved = yield* store.save({ session, expectedRevision: created.revision });
      persistedId = Option.some(saved.session.id);

      expect(saved.revision).toBe(1);
    })
  );

  it.effect("loads what the previous store persisted and rejects stale checkpoints", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const id = Option.getOrThrow(persistedId);
      const loaded = yield* store.load(id);

      expect(loaded.revision).toBe(1);
      expect(loaded.session.messages).toEqual([{ role: "user", content: "Hello" }]);

      const failure = yield* store
        .save({ session: loaded.session, expectedRevision: SessionRevision.make(0) })
        .pipe(Effect.flip);

      expect(failure).toBeInstanceOf(SessionPersistenceError);
      expect(failure.reason._tag).toBe("SessionConflict");
    })
  );
});
