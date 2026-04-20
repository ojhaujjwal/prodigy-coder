import { describe, it, expect } from "@effect/vitest";
import { needsApproval } from "./approval.ts";

describe("approval", () => {
  describe("needsApproval", () => {
    it('returns false for any tool in "none" mode', () => {
      expect(needsApproval("shell", "none")).toBe(false);
      expect(needsApproval("read", "none")).toBe(false);
      expect(needsApproval("write", "none")).toBe(false);
      expect(needsApproval("edit", "none")).toBe(false);
    });

    it('returns true for dangerous tools in "dangerous" mode', () => {
      expect(needsApproval("shell", "dangerous")).toBe(true);
      expect(needsApproval("write", "dangerous")).toBe(true);
      expect(needsApproval("edit", "dangerous")).toBe(true);
    });

    it('returns false for non-dangerous tools in "dangerous" mode', () => {
      expect(needsApproval("read", "dangerous")).toBe(false);
      expect(needsApproval("grep", "dangerous")).toBe(false);
      expect(needsApproval("glob", "dangerous")).toBe(false);
      expect(needsApproval("webfetch", "dangerous")).toBe(false);
    });

    it('returns true for all tools in "all" mode', () => {
      expect(needsApproval("shell", "all")).toBe(true);
      expect(needsApproval("read", "all")).toBe(true);
      expect(needsApproval("write", "all")).toBe(true);
      expect(needsApproval("edit", "all")).toBe(true);
      expect(needsApproval("grep", "all")).toBe(true);
      expect(needsApproval("glob", "all")).toBe(true);
      expect(needsApproval("webfetch", "all")).toBe(true);
    });
  });
});
