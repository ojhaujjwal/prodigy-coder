import { Effect, Console } from "effect";
import { Command } from "effect/unstable/cli";
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices";
import { app } from "../index.ts";

const program = Command.runWith(app, { version: "0.0.1" })(["session", "list"]).pipe(Effect.provide(bunServicesLayer));

Effect.runPromise(program)
  .then(() => Console.log("DONE"))
  .catch((e) => Console.error(String(e)));
