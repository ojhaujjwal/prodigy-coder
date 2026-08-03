import { describe, expect } from "@effect/vitest";
import { it } from "vitest";
import { mapAgentFinishReason } from "./agent-event.ts";

describe("mapAgentFinishReason", () => {
  it("maps every provider finish reason onto the AgentFinishReason vocabulary", () => {
    expect(mapAgentFinishReason("stop")).toBe("stop");
    expect(mapAgentFinishReason("length")).toBe("length");
    expect(mapAgentFinishReason("content-filter")).toBe("content-filter");
    expect(mapAgentFinishReason("tool-calls")).toBe("tool-calls");
    expect(mapAgentFinishReason("error")).toBe("error");
    expect(mapAgentFinishReason("pause")).toBe("pause");
    expect(mapAgentFinishReason("other")).toBe("other");
    expect(mapAgentFinishReason("unknown")).toBe("unknown");
  });
});
