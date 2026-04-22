import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, ConfigProvider } from "effect";
import { Command } from "effect/unstable/cli";
import * as TestConsole from "effect/testing/TestConsole";
import * as FileSystem from "effect/FileSystem";
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices";
import { app } from "../index.ts";
import { SessionRepo } from "../session.ts";

const runApp = (args: ReadonlyArray<string>) =>
  Command.runWith(app, { version: "0.0.1" })(args).pipe(Effect.provide(bunServicesLayer));

const testConfigProvider = ConfigProvider.fromUnknown({
  PRODIGY_CODER_API_KEY: "test-key"
});

const testLayer = Layer.merge(
  TestConsole.layer,
  Layer.merge(ConfigProvider.layerAdd(testConfigProvider, { asPrimary: true }), SessionRepo.layer)
);

const combinedLayer = Layer.merge(bunServicesLayer, testLayer).pipe(Layer.provide(bunServicesLayer));

const cleanupSessions = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(".prodigy-coder/sessions");
    if (exists) {
      yield* fs.remove(".prodigy-coder/sessions", { recursive: true });
    }
  });

describe("CLI integration", () => {
  it.effect("session list with no sessions", () =>
    Effect.gen(function* () {
      yield* cleanupSessions();
      yield* runApp(["session", "list"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("No sessions found"))).toBe(true);
    }).pipe(Effect.provide(combinedLayer))
  );

  it.effect("session list with sessions", () =>
    Effect.gen(function* () {
      const repo = yield* SessionRepo;
      const session = yield* repo.create();
      yield* repo.save(session);

      yield* runApp(["session", "list"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes(session.id))).toBe(true);

      yield* repo.delete(session.id);
    }).pipe(Effect.provide(combinedLayer))
  );

  it.effect("session delete", () =>
    Effect.gen(function* () {
      const repo = yield* SessionRepo;
      const session = yield* repo.create();
      yield* repo.save(session);

      yield* runApp(["session", "delete", session.id]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("Deleted session"))).toBe(true);
    }).pipe(Effect.provide(combinedLayer))
  );

  it.effect("config show", () =>
    Effect.gen(function* () {
      yield* runApp(["config", "show"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("***"))).toBe(true);
    }).pipe(Effect.provide(combinedLayer))
  );

  it.effect("main command with no prompt", () =>
    Effect.gen(function* () {
      yield* runApp(["prodigy"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("No prompt provided"))).toBe(true);
    }).pipe(Effect.provide(combinedLayer))
  );
});
