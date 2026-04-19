import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SessionRepo } from "./session.ts"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"

const testLayer = SessionRepo.layer.pipe(Layer.provide(bunServicesLayer))

describe("session", () => {

  const cleanupSessions = () =>
    Effect.sync(() => {
      try {
        const { existsSync, rmSync } = require("node:fs")
        if (existsSync(".prodigy-coder/sessions")) {
          rmSync(".prodigy-coder/sessions", { recursive: true, force: true })
        }
      } catch {}
    })

  describe("createSession", () => {
    it.effect("returns session with valid UUID and empty messages", () =>
      Effect.gen(function* () {
        yield* cleanupSessions()
        const repo = yield* SessionRepo
        const session = yield* repo.create()

        assert.isString(session.id)
        assert.isTrue(session.id.length > 0)
        assert.isTrue(session.messages.length === 0)
        assert.isTrue(session.createdAt instanceof Date)
        assert.isTrue(session.updatedAt instanceof Date)
      }).pipe(Effect.provide(testLayer)))

    it.effect("createSession with systemPrompt adds it as first message", () =>
      Effect.gen(function* () {
        yield* cleanupSessions()
        const repo = yield* SessionRepo
        const session = yield* repo.create("You are a helpful assistant")

        assert.equal(session.messages.length, 1)
        assert.equal(session.messages[0].role, "system")
        assert.equal(session.messages[0].content, "You are a helpful assistant")
      }).pipe(Effect.provide(testLayer)))
  })

  describe("saveSession and loadSession", () => {
    it.effect("saveSession then loadSession returns equivalent session", () =>
      Effect.gen(function* () {
        yield* cleanupSessions()
        const repo = yield* SessionRepo
        const session = yield* repo.create("Test prompt")
        session.messages.push({ role: "user", content: "Hello" })
        session.messages.push({ role: "assistant", content: "Hi there!" })

        yield* repo.save(session)

        const loaded = yield* repo.load(session.id)

        assert.equal(loaded.id, session.id)
        assert.equal(loaded.messages.length, session.messages.length)
        assert.equal(loaded.messages[0].role, "system")
        assert.equal(loaded.messages[0].content, "Test prompt")
        assert.equal(loaded.messages[1].role, "user")
        assert.equal(loaded.messages[1].content, "Hello")
        assert.equal(loaded.messages[2].role, "assistant")
        assert.equal(loaded.messages[2].content, "Hi there!")
      }).pipe(Effect.provide(testLayer)))
  })

  describe("listSessions", () => {
    it.effect("returns empty array when no sessions exist", () =>
      Effect.gen(function* () {
        yield* cleanupSessions()
        const repo = yield* SessionRepo
        const sessions = yield* repo.list()
        assert.isTrue(Array.isArray(sessions))
        assert.isTrue(sessions.length === 0)
      }).pipe(Effect.provide(testLayer)))

    it.effect("returns created sessions", () =>
      Effect.gen(function* () {
        yield* cleanupSessions()
        const repo = yield* SessionRepo
        const session1 = yield* repo.create()
        const session2 = yield* repo.create()
        yield* repo.save(session1)
        yield* repo.save(session2)

        const sessions = yield* repo.list()

        assert.isTrue(sessions.length >= 2)
        const ids: string[] = sessions.map((s) => s.id)
        assert.isTrue(ids.includes(session1.id))
        assert.isTrue(ids.includes(session2.id))
      }).pipe(Effect.provide(testLayer)))
  })

  describe("deleteSession", () => {
    it.effect("removes session file", () =>
      Effect.gen(function* () {
        yield* cleanupSessions()
        const repo = yield* SessionRepo
        const session = yield* repo.create()
        yield* repo.save(session)
        const sessionId = session.id

        const sessionsBefore = yield* repo.list()
        assert.isTrue(sessionsBefore.some((s) => s.id === sessionId))

        yield* repo.delete(sessionId)

        const sessionsAfter = yield* repo.list()
        assert.isFalse(sessionsAfter.some((s) => s.id === sessionId))
      }).pipe(Effect.provide(testLayer)))

    it.effect("does not throw for non-existent session", () =>
      Effect.gen(function* () {
        yield* cleanupSessions()
        const repo = yield* SessionRepo
        yield* repo.delete("non-existent-id")
      }).pipe(Effect.provide(testLayer)))
  })

  describe("loadSession", () => {
    it.effect("throws for non-existent session", () =>
      Effect.gen(function* () {
        yield* cleanupSessions()
        const repo = yield* SessionRepo
        yield* repo.load("non-existent-id")
      }).pipe(
        Effect.provide(testLayer),
        Effect.flip,
        Effect.map((error) => {
          assert.isTrue(error !== undefined)
        })
      ))
  })
})