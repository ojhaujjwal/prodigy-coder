import type { Message, ToolApprovalRequestPart } from "../capabilities/session.ts";
import type { AssistantToolCall, TurnState } from "./turn-reducer.ts";

type AssistantPart = { readonly type: "text"; readonly text: string } | AssistantToolCall | ToolApprovalRequestPart;

/**
 * Assemble the messages a completed turn appends to the session transcript,
 * preserving part order: assistant text before tool calls, approval responses
 * grouped with tool results. Returns an empty array when the turn produced no
 * commit-worthy content.
 */
export const assembleMessages = (state: TurnState) => {
  const messages: Array<Message> = [];
  if (state.assistantParts.length > 0 || state.assistantText.length > 0) {
    const content: string | ReadonlyArray<AssistantPart> =
      state.assistantParts.length > 0
        ? [
            ...(state.assistantText.length > 0
              ? [{ type: "text", text: state.assistantText } satisfies AssistantPart]
              : []),
            ...state.assistantParts
          ]
        : state.assistantText;
    messages.push({ role: "assistant", content });
  }
  if (state.toolParts.length > 0 || state.approvalParts.length > 0) {
    messages.push({ role: "tool", content: [...state.toolParts, ...state.approvalParts] });
  }
  return messages;
};
