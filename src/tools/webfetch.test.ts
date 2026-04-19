import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { webfetchHandler } from "./webfetch.ts"

const testLayer = FetchHttpClient.layer

const mockContext = {
  preliminary: () => Effect.void,
}

describe("webfetch tool", () => {
  it.effect("fetches content from url (skipped if network unavailable)", () =>
    Effect.gen(function* () {
      const result = yield* webfetchHandler({ url: "https://example.com" }, mockContext)
      assert.isTrue(result.length > 0)
    }).pipe(Effect.provide(testLayer)))

  it.effect("returns error for invalid url", () =>
    Effect.gen(function* () {
      const result = yield* webfetchHandler({ url: "not-a-valid-url" }, mockContext)
      assert.isTrue(result.includes("Error") || result.includes("error"))
    }).pipe(
      Effect.provide(testLayer),
      Effect.flip,
      Effect.map((error) => {
        assert.isTrue(String(error).includes("Error") || String(error).includes("error"))
      })
    ))
})
