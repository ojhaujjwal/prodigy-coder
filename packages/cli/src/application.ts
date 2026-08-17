import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import * as Stdio from "effect/Stdio";
import { AppConfig, loadConfig } from "./config.ts";
import { makeFileLoggerLayer } from "./logger.ts";
import { fileSessionStoreLayer } from "@prodigy/core";
import { layer as workspaceLayer } from "./adapters/workspace.ts";
import { layer as commandExecutorLayer } from "./adapters/command-executor.ts";

const configPathFromArgs = (args: readonly string[]): string | undefined => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg?.startsWith("--config=")) return arg.slice("--config=".length);
    if (arg === "--config") return args[index + 1];
  }
  return undefined;
};

/** Static CLI authorities shared by commands and the core-backed run path. */
export const applicationLayer = Layer.mergeAll(
  Layer.unwrap(
    Stdio.Stdio.pipe(
      Effect.flatMap((stdio) => stdio.args),
      Effect.map((args) => loadConfig(configPathFromArgs(args)))
    )
  ),
  makeFileLoggerLayer(),
  fileSessionStoreLayer(".prodigy-coder/sessions"),
  workspaceLayer("."),
  commandExecutorLayer(".")
).pipe(Layer.provideMerge(BunServices.layer));

export { AppConfig };
