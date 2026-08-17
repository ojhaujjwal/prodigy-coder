import { layer, expect } from "@effect/vitest";
import { Effect, Layer, ConfigProvider } from "effect";
import { Command } from "effect/unstable/cli";
import * as TestConsole from "effect/testing/TestConsole";
import * as FileSystem from "effect/FileSystem";
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices";
import { app } from "../index.ts";
import { loadConfig } from "../config.ts";
import { SessionStore, fileSessionStoreLayer } from "@prodigy/core";

const runApp = (args: ReadonlyArray<string>) => Command.runWith(app, { version: "0.0.1" })(args);

const testConfigProvider = ConfigProvider.fromUnknown({
  HOME: "/tmp/prodigy-cli-test-home",
  PRODIGY_CODER_API_KEY: "test-key"
});

const TEST_SESSION_DIR = ".prodigy-coder/test-sessions";

const appConfigLayer = loadConfig().pipe(
  Layer.provideMerge(Layer.merge(bunServicesLayer, ConfigProvider.layerAdd(testConfigProvider, { asPrimary: true })))
);

const coreSessionLayer = fileSessionStoreLayer(TEST_SESSION_DIR).pipe(Layer.provideMerge(bunServicesLayer));

const testLayer = Layer.mergeAll(TestConsole.layer, appConfigLayer, coreSessionLayer);

const cleanupSessions = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(TEST_SESSION_DIR);
    if (exists) {
      yield* fs.remove(TEST_SESSION_DIR, { recursive: true });
    }
  });

layer(testLayer)("CLI integration", (it) => {
  it.effect("session list with no sessions", () =>
    Effect.gen(function* () {
      yield* cleanupSessions();
      yield* runApp(["session", "list"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("No sessions found"))).toBe(true);
    })
  );

  it.effect("session list with sessions", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const snapshot = yield* store.create({});
      yield* store.save({ session: snapshot.session, expectedRevision: snapshot.revision });

      yield* runApp(["session", "list"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes(snapshot.session.id))).toBe(true);

      yield* store.delete(snapshot.session.id);
    })
  );

  it.effect("session delete", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const snapshot = yield* store.create({});
      yield* store.save({ session: snapshot.session, expectedRevision: snapshot.revision });

      yield* runApp(["session", "delete", snapshot.session.id]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("Deleted session"))).toBe(true);
    })
  );

  it.effect("config show", () =>
    Effect.gen(function* () {
      yield* runApp(["config", "show"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("***"))).toBe(true);
    })
  );

  it.effect("main command with no prompt", () =>
    Effect.gen(function* () {
      yield* runApp(["prodigy"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("No prompt provided"))).toBe(true);
    })
  );

  it.effect("main command accepts --continue flag", () =>
    Effect.gen(function* () {
      yield* runApp(["prodigy", "--continue"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("No prompt provided"))).toBe(true);
    })
  );

  it.effect("main command accepts --continue with --session", () =>
    Effect.gen(function* () {
      yield* runApp(["prodigy", "--continue", "--session", "abc123"]);
      const logs = yield* TestConsole.logLines;
      expect(logs.some((log) => String(log).includes("No prompt provided"))).toBe(true);
    })
  );

  it.effect("session save and load roundtrip persists messages", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      yield* cleanupSessions();

      const session1 = yield* store.create({ systemPrompt: "system prompt" });
      const firstSession = {
        ...session1.session,
        messages: [
          ...session1.session.messages,
          { role: "user" as const, content: "hello" },
          { role: "assistant" as const, content: "hi there" }
        ]
      };
      const saved1 = yield* store.save({ session: firstSession, expectedRevision: session1.revision });

      const loaded = yield* store.load(session1.session.id);
      expect(loaded.session.id).toBe(session1.session.id);
      expect(loaded.session.messages.length).toBe(3);
      expect(loaded.session.messages[1].role).toBe("user");
      expect(loaded.session.messages[1].content).toBe("hello");
      expect(loaded.session.messages[2].role).toBe("assistant");
      expect(loaded.session.messages[2].content).toBe("hi there");

      const secondSession = {
        ...saved1.session,
        messages: [...saved1.session.messages, { role: "user" as const, content: "how are you?" }]
      };
      yield* store.save({ session: secondSession, expectedRevision: saved1.revision });

      const loaded2 = yield* store.load(session1.session.id);
      expect(loaded2.session.messages.length).toBe(4);
      expect(loaded2.session.messages[3].role).toBe("user");
      expect(loaded2.session.messages[3].content).toBe("how are you?");

      yield* cleanupSessions();
    })
  );
});
