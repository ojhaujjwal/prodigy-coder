import type { AgentEvent, JsonValue } from "@prodigy/core";
import { Match, Predicate } from "effect";
import type { OutputEvent } from "./output.ts";

/** Render a core tool output value as a display string. */
const formatCoreToolOutput = (output: JsonValue): string => {
  if (Array.isArray(output)) return output.join("\n");
  return Predicate.isString(output) ? output : JSON.stringify(output);
};

/**
 * Translate a single core {@link AgentEvent} into CLI presentation events.
 *
 * Total by construction: every core event kind is either projected to one or
 * more {@link OutputEvent}s or explicitly declared presentation-internal (it
 * yields no events). `Match.exhaustive` makes the matcher require a handler
 * for every `type`, so any event kind core adds in the future fails to compile
 * here until a presentation decision is made, and a new core event can never
 * be silently dropped.
 */
export const translateAgentEvent = Match.type<AgentEvent>().pipe(
  Match.discriminators("type")({
    "run-started": (event): readonly OutputEvent[] => [{ type: "session-info", sessionId: event.sessionId }],
    // Presentation-internal: a turn boundary has no user-facing output of its
    // own.
    "turn-started": (): readonly OutputEvent[] => [],
    "text-delta": (event): readonly OutputEvent[] => [{ type: "text-delta", delta: event.delta }],
    "tool-call": (event): readonly OutputEvent[] => [
      {
        type: "tool-call",
        id: event.callId,
        name: event.toolName,
        params: event.input
      }
    ],
    "tool-result": (event): readonly OutputEvent[] =>
      event.outcome._tag === "Success"
        ? [
            {
              type: "tool-result",
              id: event.callId,
              name: event.toolName,
              result: formatCoreToolOutput(event.outcome.output),
              isError: false
            }
          ]
        : [
            {
              type: "tool-result",
              id: event.callId,
              name: event.toolName,
              result: event.outcome.error,
              isError: true
            }
          ],
    // Presentation-internal: interaction is fulfilled through the
    // `HumanInteraction` adapter, so there is no separate output for it.
    "interaction-requested": (): readonly OutputEvent[] => [],
    "run-ended": (event): readonly OutputEvent[] =>
      event.result._tag === "Finished"
        ? [{ type: "finish", text: event.result.finishReason }]
        : [{ type: "error", message: `Max turns exceeded (${event.result.limit})` }]
  }),
  Match.exhaustive
);
