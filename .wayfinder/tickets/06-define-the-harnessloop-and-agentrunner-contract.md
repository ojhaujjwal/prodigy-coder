---
title: Define the HarnessLoop and AgentRunner Contract
type: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - 01-define-the-prodigyagent-run-contract.md
---

# Define the HarnessLoop and AgentRunner Contract

## Question

What generic `AgentRunner` contract should the Ralph-style `HarnessLoop` consume, and which policies belong in the loop for prompt construction, progress, checks, completion signals, retries, interruption, commits, rollback, and partial work? Ensure Prodigy, OpenCode, and remote workers can be interchangeable runners.
