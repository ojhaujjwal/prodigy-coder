import { Context, Effect, Schema } from "effect";
import type { Duration } from "effect/Duration";
import type { WorkspacePath } from "./workspace.ts";

/** A structured request to execute a command. */
export type CommandRequest = {
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: WorkspacePath;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeout?: Duration;
};

/** The completion result of a command: exit code plus captured output. */
export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** The reasons a command could not be executed or completed. */
export class CommandExecuteError extends Schema.TaggedErrorClass<CommandExecuteError>()("CommandExecuteError", {
  reason: Schema.Literals(["Spawn", "Timeout", "Interrupted", "OutputLimit", "Transport"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * The agent-facing authority for running commands under an explicit execution
 * and resource policy. A non-zero exit code is a normal `CommandResult`;
 * `CommandExecuteError` covers spawn, timeout, and output/resource failures.
 */
export class CommandExecutor extends Context.Service<
  CommandExecutor,
  {
    readonly execute: (request: CommandRequest) => Effect.Effect<CommandResult, CommandExecuteError>;
  }
>()("@prodigy/core/capabilities/command-executor/CommandExecutor") {}
