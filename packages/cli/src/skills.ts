import { Effect, Layer, Option, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { SkillName as CoreSkillName, SkillRepository } from "@prodigy/core";

export interface Skill {
  readonly name: CoreSkillName;
  readonly description: string;
  readonly content: string;
  readonly source: "cwd" | "home";
  readonly disableModelInvocation: boolean;
}

export const makeSkillRepositoryLayer = (skills: readonly Skill[]): Layer.Layer<SkillRepository> =>
  Layer.succeed(
    SkillRepository,
    SkillRepository.of({
      findByName: (name) => Effect.succeed(Option.fromUndefinedOr(skills.find((skill) => skill.name === name))),
      autoInvokable: Effect.succeed(skills.filter((skill) => !skill.disableModelInvocation))
    })
  );

export const parseFrontmatter = (
  fileContent: string
): Option.Option<{ name: string; description: string; content: string; disableModelInvocation: boolean }> => {
  if (!fileContent.startsWith("---")) return Option.none();
  const closeIndex = fileContent.indexOf("---", 3);
  if (closeIndex === -1) return Option.none();
  const fmBlock = fileContent.slice(3, closeIndex);
  const content = fileContent.slice(closeIndex + 3).trim();
  const name = fmBlock.match(/^name:\s*(.+)/m)?.[1]?.trim();
  if (!name) return Option.none();
  const description = fmBlock.match(/^description:\s*(.+)/m)?.[1]?.trim() ?? "";
  const disableModelInvocation = /^disable_model_invocation:\s*true\s*$/im.test(fmBlock);
  return Option.some({ name, description, content, disableModelInvocation });
};

const discoverFromSource = (basePath: string, source: "cwd" | "home") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skillsDir = path.join(basePath, ".agents", "skills");
    const dirExists = yield* fs.exists(skillsDir);
    if (!dirExists) return [];

    const entries = yield* fs.readDirectory(skillsDir);
    const skills: Skill[] = [];

    for (const entry of entries) {
      const skillFile = path.join(skillsDir, entry, "SKILL.md");
      yield* fs.readFileString(skillFile).pipe(
        Effect.map((content) => {
          Option.tap(parseFrontmatter(content), (parsed) => {
            const name = Schema.decodeUnknownOption(CoreSkillName)(parsed.name);
            if (Option.isSome(name)) {
              skills.push({
                name: name.value,
                description: parsed.description,
                content: parsed.content,
                source,
                disableModelInvocation: parsed.disableModelInvocation
              });
            }
            return Option.none();
          });
        }),
        Effect.catch(() => Effect.void)
      );
    }

    return skills;
  });

export const discoverSkills = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.realPath(".");

    const cwdSkills = yield* discoverFromSource(cwd, "cwd");
    const homeSkills = yield* discoverFromSource(home, "home");

    const cwdNames = new Set(cwdSkills.map((s) => s.name));
    const homeFiltered = homeSkills.filter((s) => !cwdNames.has(s.name));

    return [...cwdSkills, ...homeFiltered];
  });

export const formatSkillsIndex = (skills: readonly Skill[]): string => {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `Available Skills (use load_skill to view full content):\n${lines.join("\n")}`;
};

export const formatSkillContent = (skill: Skill): string => `# Skill: ${skill.name}\n\n${skill.content}`;
