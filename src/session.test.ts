import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SessionRepo } from "./session.ts";
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices";

const testLayer = SessionRepo.layer.pipe(Layer.provide(bunServicesLayer));

const cleanupSessions = () =>
  Effect.sync(() => {
    const { existsSync, rmSync } = require("fs");
    try {
      if (existsSync(".prodigy-coder/sessions")) {
        rmSync(".prodigy-coder/sessions", { recursive: true, force: true });
      }
    } catch {}
  });

describe("session", () => {
  describe("createSession", () => {
    it.effect("returns session with valid UUID and empty messages", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const repo = yield* SessionRepo;
        const session = yield* repo.create();

        expect(typeof session.id).toBe("string");
        expect(session.id.length > 0).toBe(true);
        expect(session.messages.length === 0).toBe(true);
        expect(session.createdAt instanceof Date).toBe(true);
        expect(session.updatedAt instanceof Date).toBe(true);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("createSession with systemPrompt adds it as first message", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const repo = yield* SessionRepo;
        const session = yield* repo.create("You are a helpful assistant");

        expect(session.messages.length).toBe(1);
        expect(session.messages[0].role).toBe("system");
        expect(session.messages[0].content).toBe("You are a helpful assistant");
      }).pipe(Effect.provide(testLayer))
    );
  });

  describe("saveSession and loadSession", () => {
    it.effect("saveSession then loadSession returns equivalent session", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const repo = yield* SessionRepo;
        const session = yield* repo.create("Test prompt");
        session.messages.push({ role: "user", content: "Hello" });
        session.messages.push({ role: "assistant", content: "Hi there!" });

        yield* repo.save(session);

        const loaded = yield* repo.load(session.id);

        expect(loaded.id).toBe(session.id);
        expect(loaded.messages.length).toBe(session.messages.length);
        expect(loaded.messages[0].role).toBe("system");
        expect(loaded.messages[0].content).toBe("Test prompt");
        expect(loaded.messages[1].role).toBe("user");
        expect(loaded.messages[1].content).toBe("Hello");
        expect(loaded.messages[2].role).toBe("assistant");
        expect(loaded.messages[2].content).toBe("Hi there!");
      }).pipe(Effect.provide(testLayer))
    );
  });

  describe("listSessions", () => {
    it.effect("returns empty array when no sessions exist", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const repo = yield* SessionRepo;
        const sessions = yield* repo.list();
        expect(Array.isArray(sessions)).toBe(true);
        expect(sessions.length === 0).toBe(true);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("returns created sessions", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const repo = yield* SessionRepo;
        const session1 = yield* repo.create();
        const session2 = yield* repo.create();
        yield* repo.save(session1);
        yield* repo.save(session2);

        const sessions = yield* repo.list();

        expect(sessions.length >= 2).toBe(true);
        const ids: string[] = sessions.map((s) => s.id);
        expect(ids.includes(session1.id)).toBe(true);
        expect(ids.includes(session2.id)).toBe(true);
      }).pipe(Effect.provide(testLayer))
    );
  });

  describe("deleteSession", () => {
    it.effect("removes session file", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const repo = yield* SessionRepo;
        const session = yield* repo.create();
        yield* repo.save(session);
        const sessionId = session.id;

        const sessionsBefore = yield* repo.list();
        expect(sessionsBefore.some((s) => s.id === sessionId)).toBe(true);

        yield* repo.delete(sessionId);

        const sessionsAfter = yield* repo.list();
        expect(sessionsAfter.some((s) => s.id === sessionId)).toBe(false);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("does not throw for non-existent session", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const repo = yield* SessionRepo;
        yield* repo.delete("non-existent-id");
      }).pipe(Effect.provide(testLayer))
    );
  });

  describe("loadSession", () => {
    it.effect("throws for non-existent session", () =>
      Effect.gen(function* () {
        yield* cleanupSessions();
        const repo = yield* SessionRepo;
        yield* repo.load("non-existent-id");
      }).pipe(
        Effect.provide(testLayer),
        Effect.flip,
        Effect.map((error) => {
          expect(error !== undefined).toBe(true);
        })
      )
    );
  });
});
