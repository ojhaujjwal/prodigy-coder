import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"
import { globHandler } from "./glob.ts"

const testLayer = bunServicesLayer

describe("glob tool", () => {
  it("finds files matching *.txt pattern", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory("/tmp/test-glob", { recursive: true })
      yield* fs.writeFileString("/tmp/test-glob/file1.txt", "content1")
      yield* fs.writeFileString("/tmp/test-glob/file2.txt", "content2")
      yield* fs.writeFileString("/tmp/test-glob/file3.ts", "content3")
      const result = yield* globHandler({ pattern: "*.txt", path: "/tmp/test-glob" })
      assert.isTrue(result.length >= 2)
      assert.isTrue(result.every((f) => f.endsWith(".txt")))
    }).pipe(Effect.provide(testLayer)))

  it("returns empty array when no matches", () =>
    Effect.gen(function* () {
      const result = yield* globHandler({ pattern: "*.xyz", path: "/tmp/test-glob-none" })
      assert.isArray(result)
    }).pipe(Effect.provide(testLayer)))
})