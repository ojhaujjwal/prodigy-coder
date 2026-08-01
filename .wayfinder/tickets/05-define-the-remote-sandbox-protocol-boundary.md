---
title: Define the Remote Sandbox Protocol Boundary
type: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - 02-define-capability-services-and-layer-composition.md
  - 04-define-sessionstore-checkpoint-semantics.md
---

# Define the Remote Sandbox Protocol Boundary

## Question

How do `Workspace` and `CommandExecutor` cross into an untrusted remote sandbox? Define request/response schemas, streaming or polling, cancellation, timeouts, identity, capability scoping, resource limits, failure mapping, and the first transport without coupling the core to HTTP, stdio, or a specific vendor.
