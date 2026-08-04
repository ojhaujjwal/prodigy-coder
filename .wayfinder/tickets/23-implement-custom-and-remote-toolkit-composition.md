---
title: Implement Custom and Remote Toolkit Composition
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 02-define-capability-services-and-layer-composition.md
  - 03-define-typed-toolkit-profiles-and-custom-tool-composition.md
  - 21-implement-typed-agent-profile-and-toolkit-layer-composition.md
---

# Implement Custom and Remote Toolkit Composition

**What to build:** Allow callers to extend or replace the default toolkit with typed custom and remote tools using Effect AI’s native `Toolkit.merge` and Layer composition. Same-name replacement must replace the complete typed definition and handler, while remote execution remains an ordinary handler authority.

**Blocked by:** 02-define-capability-services-and-layer-composition.md; 03-define-typed-toolkit-profiles-and-custom-tool-composition.md; 21-implement-typed-agent-profile-and-toolkit-layer-composition.md

**Status:** ready-for-agent

- [ ] Compose custom tool definitions and handler Layers with the default toolkit through native Effect AI composition.
- [ ] Support complete same-name replacement of a tool’s schema, description, result/failure shape, and handler.
- [ ] Support custom remote tools through caller-provided authority Layers without adding a special remote-tool registry or protocol to core.
- [ ] Verify the composed profile remains type-safe and exposes the correct authority requirements at runtime construction.
- [ ] Add integration coverage proving custom tools execute through the public agent stream and replacement tools use their complete new definition and handler.
- [ ] Run `bun run ci` in `packages/core` successfully.
