import { describe, expect } from "@effect/vitest";
import { AiError } from "effect/unstable/ai";
import { it } from "vitest";
import { agentErrorFromToolError } from "./agent-error.ts";
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

describe("agentErrorFromToolError", () => {
  it("projects unknown tools and toolkit configuration failures into ToolSystemError", () => {
    const unknownTool = AiError.make({
      module: "test",
      method: "tool",
      reason: new AiError.ToolNotFoundError({ toolName: "missing", availableTools: ["echo"] })
    });
    const misconfigured = AiError.make({
      module: "test",
      method: "toolkit",
      reason: new AiError.ToolConfigurationError({ toolName: "echo", description: "handler missing" })
    });

    expect(agentErrorFromToolError(unknownTool)).toMatchObject({ _tag: "ToolSystemError", reason: "UnknownTool" });
    expect(agentErrorFromToolError(misconfigured)).toMatchObject({
      _tag: "ToolSystemError",
      reason: "ToolkitMisconfiguration"
    });
  });
});
