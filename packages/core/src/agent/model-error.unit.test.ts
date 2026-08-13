import { describe, expect } from "@effect/vitest";
import { AiError } from "effect/unstable/ai";
import { it } from "vitest";
import { agentErrorFromModelError, isRetryableModelReason } from "./agent-error.ts";

describe("isRetryableModelReason", () => {
  it("derives retryability from the neutral reason", () => {
    expect(isRetryableModelReason("Transport")).toBe(true);
    expect(isRetryableModelReason("RateLimit")).toBe(true);
    expect(isRetryableModelReason("Quota")).toBe(true);
    expect(isRetryableModelReason("Provider")).toBe(true);
    expect(isRetryableModelReason("Authentication")).toBe(false);
    expect(isRetryableModelReason("InvalidRequest")).toBe(false);
    expect(isRetryableModelReason("ContentPolicy")).toBe(false);
    expect(isRetryableModelReason("InvalidOutput")).toBe(false);
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
        "Transport"
      ],
      [new AiError.AuthenticationError({ kind: "InvalidKey" }), "Authentication"],
      [new AiError.RateLimitError({}), "RateLimit"],
      [new AiError.QuotaExhaustedError({}), "Quota"],
      [new AiError.InvalidRequestError({ description: "bad request" }), "InvalidRequest"],
      [new AiError.ContentPolicyError({ description: "blocked" }), "ContentPolicy"],
      [new AiError.InvalidOutputError({ description: "malformed" }), "InvalidOutput"],
      [new AiError.InternalProviderError({ description: "backend failure" }), "Provider"]
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
    expect(agentErrorFromModelError(encodedNetworkError)).toMatchObject({ _tag: "ModelError", reason: "Provider" });
  });
});
