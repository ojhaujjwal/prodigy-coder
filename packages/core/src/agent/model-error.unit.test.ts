import { describe, expect } from "@effect/vitest";
import { AiError } from "effect/unstable/ai";
import { it } from "vitest";
import { agentErrorFromModelError, isRetryableModelReason } from "./agent-error.ts";

describe("isRetryableModelReason", () => {
  it("derives retryability from the neutral reason", () => {
    expect(isRetryableModelReason("transport")).toBe(true);
    expect(isRetryableModelReason("rate-limit")).toBe(true);
    expect(isRetryableModelReason("quota")).toBe(true);
    expect(isRetryableModelReason("provider")).toBe(true);
    expect(isRetryableModelReason("authentication")).toBe(false);
    expect(isRetryableModelReason("invalid-request")).toBe(false);
    expect(isRetryableModelReason("content-policy")).toBe(false);
    expect(isRetryableModelReason("invalid-output")).toBe(false);
  });
});

describe("agentErrorFromModelError", () => {
  it("maps provider error categories to neutral model reasons", () => {
    const cases = [
      [
        new AiError.NetworkError({
          reason: "TransportError",
          request: { method: "GET", url: "https://example.com", urlParams: [], hash: undefined, headers: {} }
        }),
        "transport"
      ],
      [new AiError.AuthenticationError({ kind: "InvalidKey" }), "authentication"],
      [new AiError.RateLimitError({}), "rate-limit"],
      [new AiError.QuotaExhaustedError({}), "quota"],
      [new AiError.InvalidRequestError({ description: "bad request" }), "invalid-request"],
      [new AiError.ContentPolicyError({ description: "blocked" }), "content-policy"],
      [new AiError.InvalidOutputError({ description: "malformed" }), "invalid-output"],
      [new AiError.InternalProviderError({ description: "backend failure" }), "provider"]
    ] as const;

    for (const [reason, expected] of cases) {
      const error = AiError.make({ module: "test", method: "streamText", reason });
      const mapped = agentErrorFromModelError(error);
      expect(mapped).toMatchObject({ _tag: "ModelError", reason: expected });
      expect(mapped.isRetryable).toBe(isRetryableModelReason(expected));
    }

    const encodedNetworkError = AiError.make({
      module: "test",
      method: "streamText",
      reason: new AiError.NetworkError({
        reason: "EncodeError",
        request: { method: "GET", url: "https://example.com", urlParams: [], hash: undefined, headers: {} }
      })
    });
    expect(agentErrorFromModelError(encodedNetworkError)).toMatchObject({ _tag: "ModelError", reason: "provider" });
  });
});
