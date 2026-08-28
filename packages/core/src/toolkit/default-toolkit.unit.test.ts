import { Predicate } from "effect";
import { describe, expect, it } from "vitest";
import { CommandExecuteError } from "../capabilities/command-executor.ts";
import { HumanInteractionError } from "../capabilities/human-interaction.ts";
import { PositiveInt } from "../agent/agent-profile.ts";
import {
  WorkspaceLookupError,
  WorkspacePath,
  WorkspacePersistenceError,
  WorkspaceSearchError
} from "../capabilities/workspace/index.ts";
import { makeDefaultAgenticProfile, toToolError } from "./default-toolkit.ts";

describe("toToolError", () => {
  it("projects every capability failure to a model-facing AiError description", () => {
    const path = WorkspacePath.make("a.txt");
    const cases = [
      [new WorkspaceLookupError({ path, reason: "NotFound" }), "file not found: a.txt"],
      [new WorkspaceLookupError({ path, reason: "ReadFailure" }), "could not read: a.txt"],
      [new WorkspacePersistenceError({ path, reason: "WriteFailure" }), "write failed: a.txt"],
      [new WorkspacePersistenceError({ path, reason: "NoMatch" }), "edit target not found: a.txt"],
      [new WorkspacePersistenceError({ path, reason: "Conflict" }), "concurrent modification: a.txt"],
      [new WorkspaceSearchError({ path, reason: "SearchFailure" }), "search failed: a.txt"],
      [new CommandExecuteError({ reason: "Spawn" }), "command could not be started"],
      [new CommandExecuteError({ reason: "Timeout" }), "command timed out"],
      [new CommandExecuteError({ reason: "Interrupted" }), "command interrupted"],
      [new CommandExecuteError({ reason: "OutputLimit" }), "command output exceeded the limit"],
      [new CommandExecuteError({ reason: "Transport" }), "command transport failed"],
      [new HumanInteractionError({ reason: "Timeout" }), "human interaction timed out"],
      [new HumanInteractionError({ reason: "ChannelClosed" }), "human interaction channel closed"],
      [new HumanInteractionError({ reason: "InvalidResponse" }), "invalid response from human interaction"]
    ] as const;

    for (const [cause, description] of cases) {
      expect(toToolError("Tool", "handler")(cause)).toMatchObject({
        module: "Tool",
        method: "handler",
        reason: { _tag: "UnknownError", description }
      });
    }
  });
});

describe("makeDefaultAgenticProfile", () => {
  it("applies the caller's approval policy to the default toolkit", () => {
    const profile = makeDefaultAgenticProfile({
      systemPrompt: "Be concise",
      maxTurns: PositiveInt.make(3),
      needsApproval: (toolName) => toolName === "shell"
    });

    expect(profile.systemPrompt).toBe("Be concise");
    expect(profile.maxTurns).toBe(3);
    const shellApproval = profile.toolkit.tools.shell.needsApproval;
    const readApproval = profile.toolkit.tools.read.needsApproval;
    expect(Predicate.isFunction(shellApproval)).toBe(true);
    expect(Predicate.isFunction(readApproval)).toBe(true);
    if (Predicate.isFunction(shellApproval) && Predicate.isFunction(readApproval)) {
      expect(shellApproval({}, { toolCallId: "call", messages: [] })).toBe(true);
      expect(readApproval({}, { toolCallId: "call", messages: [] })).toBe(false);
    }
  });
});
