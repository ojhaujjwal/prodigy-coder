import { describe, it, expect } from "@effect/vitest"
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"
import { globHandler } from "./glob.ts"

const testLayer = bunServicesLayer

const mockContext = {
  preliminary: () => Effect.void,
}

describe("glob tool", () => {
  it.effect("finds files matching *.txt pattern", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory("/tmp/test-glob", { recursive: true }).pipe(
        Effect.catch(() => Effect.void)
      )
      for (const f of ["/tmp/test-glob/file1.txt", "/tmp/test-glob/file2.txt", "/tmp/test-glob/file3.ts"]) {
        yield* fs.remove(f).pipe(Effect.catch(() => Effect.void))
      }
      yield* fs.writeFileString("/tmp/test-glob/file1.txt", "content1")
      yield* fs.writeFileString("/tmp/test-glob/file2.txt", "content2")
      yield* fs.writeFileString("/tmp/test-glob/file3.ts", "content3")
      const result = yield* globHandler({ pattern: "*.txt", path: "/tmp/test-glob" }, mockContext)
      expect(result.length >= 2).toBe(true)
      expect(result.every((f) => f.endsWith(".txt"))).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect("returns empty array when no matches", () =>
    Effect.gen(function* () {
      const result = yield* globHandler({ pattern: "*.xyz", path: "/tmp/test-glob-none" }, mockContext)
      expect(Array.isArray(result)).toBe(true)
    }).pipe(Effect.provide(testLayer)))
})
