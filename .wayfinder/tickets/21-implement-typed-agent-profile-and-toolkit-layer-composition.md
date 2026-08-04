---
title: Implement Typed Agent Profile and Toolkit Layer Composition
type: wayfinder:implementation
status: open
parent: ../map.md
blocked_by:
  - 02-define-capability-services-and-layer-composition.md
  - 03-define-typed-toolkit-profiles-and-custom-tool-composition.md
  - 14-implement-the-lazy-prodigyagent-run.md
---

# Implement Typed Agent Profile and Toolkit Layer Composition

**What to build:** Bind a caller-selected, compile-time checked Effect AI toolkit and its handler Layer into a stable `ProdigyAgent` runtime. The composition root should expose one agent service while preserving the selected toolkit’s authority requirements and preventing per-run toolkit replacement.

**Blocked by:** 02-define-capability-services-and-layer-composition.md; 03-define-typed-toolkit-profiles-and-custom-tool-composition.md; 14-implement-the-lazy-prodigyagent-run.md

**Status:** ready-for-agent

- [ ] Implement the typed agent profile containing toolkit, handler Layer, system prompt, and bounded execution policy.
- [ ] Implement the generic composition factory that produces a stable `ProdigyAgent` Layer from a profile.
- [ ] Preserve compile-time toolkit/handler pairing and authority requirements without unchecked casts or an untyped registry.
- [ ] Ensure the selected toolkit is bound at runtime construction and cannot be replaced through a run request.
- [ ] Add integration/type-level coverage for profiles with different authority requirements, including profiles that do and do not require `HumanInteraction`.
- [ ] Run `bun run ci` in `packages/core` successfully.
