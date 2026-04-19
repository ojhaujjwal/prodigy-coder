import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { needsApproval } from "./approval.ts"

describe("approval", () => {
  describe("needsApproval", () => {
    it('returns false for any tool in "none" mode', () => {
      assert.isFalse(needsApproval("shell", "none"))
      assert.isFalse(needsApproval("read", "none"))
      assert.isFalse(needsApproval("write", "none"))
      assert.isFalse(needsApproval("edit", "none"))
    })

    it('returns true for dangerous tools in "dangerous" mode', () => {
      assert.isTrue(needsApproval("shell", "dangerous"))
      assert.isTrue(needsApproval("write", "dangerous"))
      assert.isTrue(needsApproval("edit", "dangerous"))
    })

    it('returns false for non-dangerous tools in "dangerous" mode', () => {
      assert.isFalse(needsApproval("read", "dangerous"))
      assert.isFalse(needsApproval("grep", "dangerous"))
      assert.isFalse(needsApproval("glob", "dangerous"))
      assert.isFalse(needsApproval("webfetch", "dangerous"))
    })

    it('returns true for all tools in "all" mode', () => {
      assert.isTrue(needsApproval("shell", "all"))
      assert.isTrue(needsApproval("read", "all"))
      assert.isTrue(needsApproval("write", "all"))
      assert.isTrue(needsApproval("edit", "all"))
      assert.isTrue(needsApproval("grep", "all"))
      assert.isTrue(needsApproval("glob", "all"))
      assert.isTrue(needsApproval("webfetch", "all"))
    })
  })
})