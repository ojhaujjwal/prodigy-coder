import { Effect, Layer, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { CommandExecutor, CommandExecuteError, type CommandRequest, type CommandResult } from "@prodigy/core";

const make = (root: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const workspaceRoot = path.resolve(root);

    const execute = Effect.fn("CommandExecutorAdapter.execute")(function* (
      request: CommandRequest
    ): Effect.fn.Return<CommandResult, CommandExecuteError> {
      const executable = request.argv[0];
      if (executable === undefined) {
        return yield* new CommandExecuteError({ reason: "Spawn", cause: new Error("Command argv is empty") });
      }
      const cwd = request.cwd === undefined ? workspaceRoot : path.resolve(workspaceRoot, request.cwd);
      const relativeCwd = path.relative(workspaceRoot, cwd);
      if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
        return yield* new CommandExecuteError({ reason: "Spawn", cause: new Error("Command cwd escapes workspace") });
      }
      const command = ChildProcess.make(executable, request.argv.slice(1), {
        cwd,
        env: request.environment,
        extendEnv: request.environment === undefined
      });
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(command)
            .pipe(Effect.mapError((cause) => new CommandExecuteError({ reason: "Spawn", cause })));
          const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
            Stream.mkString(Stream.decodeText(stream));
          const result = yield* Effect.all(
            {
              stdout: collect(handle.stdout),
              stderr: collect(handle.stderr),
              exitCode: handle.exitCode
            },
            { concurrency: "unbounded" }
          );
          return { exitCode: Number(result.exitCode), stdout: result.stdout, stderr: result.stderr };
        })
      ).pipe(
        Effect.timeoutOrElse({
          duration: request.timeout ?? "10 minutes",
          orElse: () => Effect.fail(new CommandExecuteError({ reason: "Timeout" }))
        }),
        Effect.mapError((cause) =>
          cause._tag === "CommandExecuteError" ? cause : new CommandExecuteError({ reason: "Transport", cause })
        )
      );
    });

    return CommandExecutor.of({ execute });
  });

export const layer = (root: string) => Layer.effect(CommandExecutor, make(root));
