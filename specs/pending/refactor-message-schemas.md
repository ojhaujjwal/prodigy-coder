# Refactor Message and MessagePart Schemas to Match Effect Prompt Types

## Overview

Refactor the session message types in `src/session.ts` to use role-specific content schemas that align with Effect's `Prompt.MessageEncoded`. This eliminates the need for the hacky `messageToEncoded` conversion in `src/agent.ts`, which currently filters out invalid parts per role.

## Background

Currently, `MessagePart` is a single union of `text | tool-call | tool-result`, and both `user` and `assistant` messages accept `Array<MessagePart>`. This means a `user` message could theoretically contain a `tool-call` part, and a `tool` message could contain a `text` part. The `messageToEncoded` function in `src/agent.ts` works around this by manually filtering arrays at runtime with type predicates, which is fragile and unnecessary.

Effect's `Prompt.MessageEncoded` already models this correctly:
- `system`: `string`
- `user`: `string | ReadonlyArray<TextPart | FilePart>`
- `assistant`: `string | ReadonlyArray<TextPart | ToolCallPart | ...>`
- `tool`: `ReadonlyArray<ToolResultPart>`

By making our local schemas match this structure, the conversion function becomes a trivial identity mapping.

## Requirements

- [x] Role-specific message schemas replace the broad `MessagePart` + `Message` union
- [x] `messageToEncoded` in `src/agent.ts` is simplified to a direct mapping with no filtering
- [x] All existing tests continue to pass without modification to test logic
- [x] Session serialization/deserialization remains backward compatible for valid data
- [x] Type-level guarantees prevent constructing invalid messages (e.g., `tool` message with `text` part)

## Tasks

- [x] **Task 1**: Refactor `src/session.ts` to use role-specific message and part schemas
- [x] **Task 2**: Simplify `messageToEncoded` in `src/agent.ts` and update local type references
- [x] **Task 3**: Run full test suite and fix any type or runtime issues

## Implementation Details

### Task 1: Refactor `src/session.ts`

Replace the existing `MessagePart` and `Message` definitions with explicit role-specific schemas.

**New schema structure:**

```ts
// Part schemas
export const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
});
export type TextPart = typeof TextPart.Type;

export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown,
  providerExecuted: Schema.Boolean
});
export type ToolCallPart = typeof ToolCallPart.Type;

export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  isFailure: Schema.Boolean,
  result: Schema.Unknown
});
export type ToolResultPart = typeof ToolResultPart.Type;

// Message schemas
export const SystemMessage = Schema.Struct({
  role: Schema.Literal("system"),
  content: Schema.String
});
export type SystemMessage = typeof SystemMessage.Type;

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union(Schema.String, Schema.Array(TextPart))
});
export type UserMessage = typeof UserMessage.Type;

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Union(Schema.String, Schema.Array(Schema.Union(TextPart, ToolCallPart)))
});
export type AssistantMessage = typeof AssistantMessage.Type;

export const ToolMessage = Schema.Struct({
  role: Schema.Literal("tool"),
  content: Schema.Array(ToolResultPart)
});
export type ToolMessage = typeof ToolMessage.Type;

export const Message = Schema.Union(SystemMessage, UserMessage, AssistantMessage, ToolMessage);
export type Message = typeof Message.Type;

// Re-export MessagePart for backward compatibility where needed
export type MessagePart = TextPart | ToolCallPart | ToolResultPart;
```

**Update `SessionSchema`** to reference the new `Message` schema (it should remain unchanged since `Message` still covers the same union).

### Task 2: Simplify `messageToEncoded` in `src/agent.ts`

Replace the current `messageToEncoded` with a direct mapping. Update the internal arrays that collect streaming parts to use the new strict part types.

**New conversion function:**

```ts
const messageToEncoded = (msg: Message): Prompt.MessageEncoded => {
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content };
    case "user":
      return { role: "user", content: msg.content };
    case "assistant":
      return { role: "assistant", content: msg.content };
    case "tool":
      return { role: "tool", content: msg.content };
  }
};
```

**Update stream collection types:**

```ts
const assistantParts: Array<TextPart | ToolCallPart> = [];
const toolParts: Array<ToolResultPart> = [];
```

Update the `import type` from `./session.ts` to include `TextPart`, `ToolCallPart`, `ToolResultPart` if needed.

### Task 3: Run Tests and Verify

Run the full test suite to ensure no regressions.

Expected test outcomes:
- `session.test.ts`: passes (plain object literals still satisfy stricter schemas)
- `agent-integration.test.ts` and `e2e.test.ts`: passes (no logic changes, only types)
- `output.test.ts`: passes (unaffected)
- TypeScript compilation: succeeds with no errors

## Testing Plan

### Unit Tests

- `session.test.ts` — create, save, load sessions with various message shapes
- `output.test.ts` — unaffected but should still pass

### Integration Tests

- `agent-integration.test.ts` — verify prompt structure sent to LLM matches expectations
- `e2e.test.ts` — end-to-end agent loop with tool calls and results

## Verification Checklist

Before signaling `TASK_COMPLETE`, verify:

- [ ] `messageToEncoded` contains no `.filter()` calls or type predicates
- [ ] TypeScript compiler rejects invalid message constructions (e.g., a `tool` message with a `text` part)
- [ ] All existing tests pass
- [ ] Session files saved before the refactor still load correctly

## Rollback Plan

1. Revert `src/session.ts` to the original `MessagePart` + `Message` union schemas
2. Revert `src/agent.ts` to the original `messageToEncoded` with filtering logic
3. Restore original imports if changed

## Future Considerations (Optional)

- If Effect's `Prompt` later adds `FilePart` or `ReasoningPart`, extend the local schemas to match
- Consider importing Effect's part schemas directly if they are exported as Schema values in a future Effect release

## Spec Readiness Checklist

Before running ralph-loop.sh, verify:

- [x] All requirements are clearly defined (no unanswered questions)
- [x] All tasks are actionable and appropriately sized (1-4 hours each)
- [x] **All tasks are atomic (each task leaves codebase in working state)**
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable
- [x] Rollback plan exists
