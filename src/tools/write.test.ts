import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import * as FileSystem from "effect/FileSystem"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"
import { writeHandler } from "./write.ts"

const testLayer = bunServicesLayer

const mockContext = {
  preliminary: () => Effect.void,
}

describe("write tool", () => {
  it("creates new file with correct content", () =>
    Effect.gen(function* () {
      const result = yield* writeHandler({ filePath: "/tmp/test-write.txt", content: "Test content" }, mockContext)
      assert.equal(result, "Written to /tmp/test-write.txt")
      const fs = yield* FileSystem.FileSystem
      const content = yield* fs.readFileString("/tmp/test-write.txt")
      assert.equal(content, "Test content")
    }).pipe(Effect.provide(testLayer)))

  it("overwrites existing file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/tmp/test-write2.txt", "Original")
      yield* writeHandler({ filePath: "/tmp/test-write2.txt", content: "Updated" }, mockContext)
      const content = yield* fs.readFileString("/tmp/test-write2.txt")
      assert.equal(content, "Updated")
    }).pipe(Effect.provide(testLayer)))

  it("creates parent directories", () =>
    Effect.gen(function* () {
      const result = yield* writeHandler({ filePath: "/tmp/test-dir/nested/file.txt", content: "Nested" }, mockContext)
      assert.isTrue(result.includes("Written to"))
      const fs = yield* FileSystem.FileSystem
      const content = yield* fs.readFileString("/tmp/test-dir/nested/file.txt")
      assert.equal(content, "Nested")
    }).pipe(Effect.provide(testLayer)))
})
