---
title: Define CLI Compatibility and Entrypoint Migration
type: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - 01-define-the-prodigyagent-run-contract.md
  - 02-define-capability-services-and-layer-composition.md
  - 06-define-the-harnessloop-and-agentrunner-contract.md
---

# Define CLI Compatibility and Entrypoint Migration

## Question

How should the current Bun CLI, flags, session commands, formatters, and shell composition migrate onto the SDK without import-time side effects or behavior regressions? Define entrypoints, compatibility guarantees, configuration ownership, and the sequence for moving `src/index.ts` responsibilities.
