---
title: Migrate the Default Agentic Toolkit Behind Capability Services
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 02-define-capability-services-and-layer-composition.md
  - 03-define-typed-toolkit-profiles-and-custom-tool-composition.md
  - 09-define-built-in-tool-failure-schemas.md
  - 21-implement-typed-agent-profile-and-toolkit-layer-composition.md
---

# Migrate the Default Agentic Toolkit Behind Capability Services

**What to build:** Provide the compatibility-default toolkit through the typed profile/composition seam while preserving its existing model-facing names, schemas, and result shapes. Its handlers must use the application-owned capability services rather than direct platform dependencies.

**Blocked by:** 02-define-capability-services-and-layer-composition.md; 03-define-typed-toolkit-profiles-and-custom-tool-composition.md; 09-define-built-in-tool-failure-schemas.md; 21-implement-typed-agent-profile-and-toolkit-layer-composition.md

**Status:** ready-for-agent

- [ ] Implement the compatibility-default toolkit with `shell`, `read`, `write`, `edit`, `grep`, `glob`, `webfetch`, `ask_user`, and `load_skill`.
- [ ] Preserve the existing model-facing schemas, descriptions, tool names, and compatibility result shapes.
- [ ] Migrate file operations behind `Workspace`, command execution behind `CommandExecutor`, and interaction-dependent behavior behind `HumanInteraction` where selected.
- [ ] Keep platform-specific adapters outside the core authority contracts.
- [ ] Apply the defined per-tool typed failure schemas and project authority failures into the compatibility surface.
- [ ] Add end-to-end integration coverage for the default toolkit through a composed runtime with test capability Layers.
- [ ] Run `bun run ci` in `packages/core` successfully.
