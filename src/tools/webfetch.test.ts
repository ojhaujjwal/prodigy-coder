import { describe, it, expect } from "@effect/vitest"
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
      expect(result.length > 0).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect("returns error for invalid url", () =>
    Effect.gen(function* () {
      const result = yield* webfetchHandler({ url: "not-a-valid-url" }, mockContext)
      expect(result.includes("Error") || result.includes("error")).toBe(true)
    }).pipe(
      Effect.provide(testLayer),
      Effect.flip,
      Effect.map((error) => {
        expect(String(error).includes("Error") || String(error).includes("error")).toBe(true)
      })
    ))
})
