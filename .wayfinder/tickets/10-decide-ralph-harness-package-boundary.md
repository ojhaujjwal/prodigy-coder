---
title: Decide Ralph Harness Package Boundary
type: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - 06-define-the-harnessloop-and-agentrunner-contract.md
---

# Decide Ralph Harness Package Boundary

## Question

Once `AgentRunner` is a core-owned contract and the HarnessLoop policy is defined, should Ralph ship as `@prodigy/ralph-harness`, remain an application-level composition over `@prodigy/core`, or use another boundary? Decide its public API, release relationship to core, ownership of `ralph.sh`, and whether the harness is a reusable product or only this repository's executable workflow.
