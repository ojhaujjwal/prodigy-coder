import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BunServices } from "@effect/platform-bun";
import { CommandExecutor } from "@prodigy/core";
import { layer as commandExecutorLayer } from "./command-executor.ts";

layer(BunServices.layer)("command executor adapter", (it) => {
  it.effect("returns structured output for non-zero commands", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(commandExecutorLayer.pipe(Layer.provide(BunServices.layer)));
      const executor = yield* CommandExecutor.pipe(Effect.provide(context));
      const result = yield* executor.execute({ argv: ["sh", "-c", "printf out; printf err >&2; exit 3"] });
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("out");
      expect(result.stderr).toBe("err");
    })
  );
});
