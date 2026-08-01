---
title: Define Package and Public Export Boundaries
type: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - 01-define-the-prodigyagent-run-contract.md
  - 02-define-capability-services-and-layer-composition.md
  - 06-define-the-harnessloop-and-agentrunner-contract.md
---

# Define Package and Public Export Boundaries

## Question

Should the work remain a single package with layered entrypoints or become separate core, runtime, CLI, harness, and protocol packages? Define public exports, dependency direction, Bun/Node portability, peer dependencies, and the migration path from the current private `src/index.ts` package entrypoint.
