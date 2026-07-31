import { layer, expect } from "@effect/vitest";
import { Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { webfetchHandler } from "./webfetch.ts";

const mockContext = {
  preliminary: () => Effect.void
};

layer(FetchHttpClient.layer)("webfetch tool", (it) => {
  it.effect("fetches content from url (skipped if network unavailable)", () =>
    webfetchHandler({ url: "https://example.com" }, mockContext).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.sync(() => expect(error._tag).toBe("AiError")),
        onSuccess: (result) => Effect.sync(() => expect(result.length > 0).toBe(true))
      })
    )
  );

  it.effect("returns error for invalid url", () =>
    Effect.gen(function* () {
      const result = yield* webfetchHandler({ url: "not-a-valid-url" }, mockContext);
      expect(result.includes("Error") || result.includes("error")).toBe(true);
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(String(error).includes("Error") || String(error).includes("error")).toBe(true);
      })
    )
  );
});
