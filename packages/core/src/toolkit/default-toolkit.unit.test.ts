import { describe, expect, it } from "vitest";
import { CommandExecuteError } from "../capabilities/command-executor.ts";
import { HumanInteractionError } from "../capabilities/human-interaction.ts";
import {
  WorkspaceLookupError,
  WorkspacePath,
  WorkspacePersistenceError,
  WorkspaceSearchError
} from "../capabilities/workspace.ts";
import { toToolError } from "./default-toolkit.ts";

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
