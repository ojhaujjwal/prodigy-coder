import { describe, expect, it } from "@effect/vitest";
import { approvalDecisionFromInteraction } from "../capabilities/human-interaction.ts";

describe("approvalDecisionFromInteraction", () => {
  it("projects Approved unchanged", () => {
    expect(approvalDecisionFromInteraction({ _tag: "Approved" })).toEqual({ _tag: "Approved" });
  });

  it("projects Denied with its reason when present", () => {
    expect(approvalDecisionFromInteraction({ _tag: "Denied", reason: "not now" })).toEqual({
      _tag: "Denied",
      reason: "not now"
    });
  });

  it("projects Denied without a reason when none is supplied", () => {
    expect(approvalDecisionFromInteraction({ _tag: "Denied" })).toEqual({ _tag: "Denied" });
  });

  it("projects Answered as invalid-response, never a silent approval", () => {
    expect(approvalDecisionFromInteraction({ _tag: "Answered", answer: { yes: true } })).toEqual({
      _tag: "invalid-response"
    });
  });
});
