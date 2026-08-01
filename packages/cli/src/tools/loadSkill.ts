import { Effect, Option, Schema } from "effect";
import { AiError, Tool } from "effect/unstable/ai";
import { SkillsRepo } from "../skills.ts";

const LoadSkillParameters = Schema.Struct({
  name: Schema.String
});

export const LoadSkillTool = Tool.make("load_skill", {
  description:
    "Load a skill's full instructions by name. Use to view the complete content of a skill listed in Available Skills.",
  parameters: LoadSkillParameters,
  success: Schema.String,
  failureMode: "return",
  dependencies: [SkillsRepo]
});

export type LoadSkillTool = typeof LoadSkillTool;

export const loadSkillHandler = ({ name }: { name: string }, _context: unknown) =>
  Effect.gen(function* () {
    const skillsRepo = yield* SkillsRepo;
    const skill = yield* skillsRepo.findByName(name);

    if (Option.isNone(skill)) {
      const autoInvokable = yield* skillsRepo.autoInvokable;
      const names = autoInvokable.map((s) => s.name).join(", ");
      return yield* AiError.make({
        module: "LoadSkill",
        method: "loadSkillHandler",
        reason: new AiError.UnknownError({
          description: `Skill '${name}' not found. Available auto-invokable skills: ${names}`
        })
      });
    }

    return `# Skill: ${skill.value.name}\n\n${skill.value.content}`;
  });
