# Fix Tests Using Plain it() With Effect Code

## Overview

13 test files use plain `it()` with Effect code, meaning the Effects are never executed and the tests always pass regardless of assertions. Each `it(` call that contains Effect code must be changed to `it.effect(` so the Effect runtime actually runs the test body.

## Background

`@effect/vitest` provides `it.effect()` which automatically runs the returned Effect via the Effect runtime. Plain `it()` treats the returned Effect value as a truthy value (test passes) and never executes it. This is a critical bug — all these tests were giving false passes.

The fix is mechanical: change `it(` to `it.effect(` for every test case that contains Effect patterns (`Effect.gen`, `yield*`, `Effect.provide`, etc.). The `.pipe(Effect.provide(...))` chain stays the same — `it.effect` still needs it for custom layers.

## Requirements

- [ ] All `it(` calls containing Effect code changed to `it.effect(`
- [ ] No changes to `it(` calls that are purely synchronous (no Effect code)
- [ ] Lint passes with zero `no-plain-it-with-effect` violations
- [ ] Tests actually execute their Effect bodies (previously false-passing tests may now fail)

## Tasks

Order: unit tests first, then integration, then e2e.

- [x] **Task 1**: Fix `src/config.test.ts` — change 5 `it(` to `it.effect(`
- [x] **Task 2**: Fix `src/session.test.ts` — change 8 `it(` to `it.effect(`
- [ ] **Task 3**: Fix `src/output.test.ts` — change 15 `it(` to `it.effect(`
- [ ] **Task 4**: Fix `src/tools/shell.test.ts` — change 3 `it(` to `it.effect(`
- [ ] **Task 5**: Fix `src/tools/glob.test.ts` — change 2 `it(` to `it.effect(`
- [ ] **Task 6**: Fix `src/tools/grep.test.ts` — change 2 `it(` to `it.effect(`
- [ ] **Task 7**: Fix `src/tools/read.test.ts` — change 2 `it(` to `it.effect(`
- [ ] **Task 8**: Fix `src/tools/write.test.ts` — change 3 `it(` to `it.effect(`
- [ ] **Task 9**: Fix `src/tools/edit.test.ts` — change 3 `it(` to `it.effect(`
- [ ] **Task 10**: Fix `src/tools/webfetch.test.ts` — change 2 `it(` to `it.effect(`
- [ ] **Task 11**: Fix `src/__integration__/agent-integration.test.ts` — change 10 `it(` to `it.effect(`
- [ ] **Task 12**: Fix `src/__integration__/e2e.test.ts` — change 4 `it(` to `it.effect(`
- [ ] **Task 13**: Fix `src/__integration__/output-integration.test.ts` — change 3 `it(` to `it.effect(`

## Implementation Details

### Every task follows the same pattern

For each file, the change is identical: replace `it(` with `it.effect(` on every test case that contains Effect code. No other changes needed.

**Before:**
```ts
it("should do something", () =>
  Effect.gen(function* () {
    const result = yield* someEffect
    assert.equal(result, "expected")
  }).pipe(Effect.provide(testLayer)))
```

**After:**
```ts
it.effect("should do something", () =>
  Effect.gen(function* () {
    const result = yield* someEffect
    assert.equal(result, "expected")
  }).pipe(Effect.provide(testLayer)))
```

### Per-file details

#### Task 1: `src/config.test.ts`

5 `it(` → `it.effect(` (lines 10, 38, 49, 63, 85). Lines 121 and 137 stay as `it()` — they are synchronous tests with no Effect code.

#### Task 2: `src/session.test.ts`

8 `it(` → `it.effect(` (all test cases in the file contain Effect code).

#### Task 3: `src/output.test.ts`

15 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 4: `src/tools/shell.test.ts`

3 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 5: `src/tools/glob.test.ts`

2 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 6: `src/tools/grep.test.ts`

2 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 7: `src/tools/read.test.ts`

2 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 8: `src/tools/write.test.ts`

3 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 9: `src/tools/edit.test.ts`

3 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 10: `src/tools/webfetch.test.ts`

2 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 11: `src/__integration__/agent-integration.test.ts`

10 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 12: `src/__integration__/e2e.test.ts`

4 `it(` → `it.effect(` (all test cases contain Effect code).

#### Task 13: `src/__integration__/output-integration.test.ts`

3 `it(` → `it.effect(` (all test cases contain Effect code).

## Testing Plan

### Per-task verification

After each task:
1. Run `npm test` — the file's tests should now actually execute

### Final verification

After all tasks:
1. `npm test` — all tests pass (previously false-passing tests may now legitimately fail, revealing real bugs)

## Verification Checklist

Before signaling `TASK_COMPLETE`, verify:

- [ ] `npm test` passes (or failures are real bugs now being exposed, not the migration itself)
- [ ] Every test that was `it(` with Effect code is now `it.effect(`
- [ ] No `it(` calls without Effect code were accidentally changed

## Rollback Plan

Revert all `it.effect(` back to `it(` — each file change is a simple string replacement that can be individually reverted with git.

## Spec Readiness Checklist

- [x] All requirements are clearly defined (no unanswered questions)
- [x] All tasks are actionable and appropriately sized (1-4 hours each)
- [x] **All tasks are atomic (each task leaves codebase in working state)**
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable
- [x] Rollback plan exists
