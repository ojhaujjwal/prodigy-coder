import { describe, expect, layer } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as FileSystem from "effect/FileSystem";
import { createTestSession, platformLayer } from "../../__integration__/helpers.ts";
import { layer as fileStoreLayer } from "../file-session-store.ts";
import { SessionLookupError, SessionPersistenceError, SessionStore } from "../session-store.ts";
import { SessionRevision, type SessionId, type Session } from "../session.ts";

const TEST_SESSION_DIR = "/tmp/.prodigy-core/test-sessions";

const storeLayer = fileStoreLayer(TEST_SESSION_DIR).pipe(Layer.provideMerge(platformLayer));

let persistedId: Option.Option<SessionId> = Option.none();

const cleanupSessions = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(TEST_SESSION_DIR);
    if (exists) {
      yield* fs.remove(TEST_SESSION_DIR, { recursive: true });
    }
    yield* fs.makeDirectory(TEST_SESSION_DIR, { recursive: true });
  });

layer(storeLayer)("FileSessionStore", (it) => {
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
        const session: Session = { ...created.session, messages: [{ role: "user", content: "Hello" }] };

        const saved = yield* store.save({ session, expectedRevision: created.revision });

        expect(saved.revision).toBe(1);

        const entries = yield* fs.readDirectory(TEST_SESSION_DIR);
        expect(entries).toEqual([`${created.session.id}.json`]);

        const raw = yield* fs.readFileString(`${TEST_SESSION_DIR}/${created.session.id}.json`);
        const parsed: {
          formatVersion: number;
          revision: number;
          session: { id: string; createdAt: string; updatedAt: string };
        } = JSON.parse(raw);
        expect(parsed.formatVersion).toBe(1);
        expect(parsed.revision).toBe(1);
        expect(parsed.session.id).toBe(created.session.id);
        expect(typeof parsed.session.createdAt).toBe("string");

        const loaded = yield* store.load(created.session.id);
        expect(loaded.revision).toBe(1);
        expect(loaded.session.messages).toEqual([{ role: "user", content: "Hello" }]);
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
        expect(second.session.updatedAt.getTime()).toBeGreaterThanOrEqual(created.session.updatedAt.getTime());
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
      })
    );

    it.effect("a store saves a session to disk at revision 1", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const store = yield* SessionStore;

        const created = yield* store.create({});
        const session: Session = { ...created.session, messages: [{ role: "user", content: "Hello" }] };
        const saved = yield* store.save({ session, expectedRevision: created.revision });
        persistedId = Option.some(saved.session.id);

        expect(saved.revision).toBe(1);
      })
    );

    it.layer(fileStoreLayer(TEST_SESSION_DIR))("a fresh store over the same directory", (it) => {
      it.effect("loads what the previous store persisted", () =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const loaded = yield* store.load(Option.getOrThrow(persistedId));

          expect(loaded.revision).toBe(1);
          expect(loaded.session.messages).toEqual([{ role: "user", content: "Hello" }]);
        })
      );

      it.effect("rejects a stale checkpoint from the previous instance as SessionConflict", () =>
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const loaded = yield* store.load(Option.getOrThrow(persistedId));

          const failure = yield* store
            .save({ session: loaded.session, expectedRevision: SessionRevision.make(0) })
            .pipe(Effect.flip);

          expect(failure).toBeInstanceOf(SessionPersistenceError);
          expect(failure.reason._tag).toBe("SessionConflict");
        })
      );
    });
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
