import { describe, expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { createTestSession } from "../../__integration__/helpers.ts";
import { layerNoDeps } from "../memory-session-store.ts";
import { SessionLookupError, SessionPersistenceError, SessionStore } from "../session-store.ts";
import type { Session } from "../session.ts";

const storeLayer = Layer.provideMerge(layerNoDeps, BunCrypto.layer);

layer(storeLayer)("MemorySessionStore", (it) => {
  describe("create", () => {
    it.effect("returns a revision-0 snapshot with a fresh well-formed SessionId", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const snapshot = yield* store.create({});

        expect(snapshot.revision).toBe(0);
        expect(snapshot.session.id).toMatch(/^[a-z0-9]{8}$/);
        expect(snapshot.session.messages).toEqual([]);
        expect(snapshot.session.createdAt).toBeInstanceOf(Date);
        expect(snapshot.session.updatedAt).toBeInstanceOf(Date);
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
        const session: Session = { ...created.session, messages: [{ role: "user", content: "Hello" }] };

        const saved = yield* store.save({ session, expectedRevision: created.revision });

        expect(saved.revision).toBe(1);
        expect(saved.session.messages).toEqual([{ role: "user", content: "Hello" }]);

        const loaded = yield* store.load(created.session.id);
        expect(loaded.revision).toBe(1);
        expect(loaded.session.messages).toEqual([{ role: "user", content: "Hello" }]);
      })
    );

    it.effect("save refreshes updatedAt and keeps createdAt stable", () =>
      Effect.gen(function* () {
        const store = yield* SessionStore;
        const created = yield* store.create({});

        const saved = yield* store.save({ session: created.session, expectedRevision: created.revision });

        expect(saved.session.createdAt).toEqual(created.session.createdAt);
        expect(saved.session.updatedAt.getTime()).toBeGreaterThanOrEqual(created.session.updatedAt.getTime());
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
