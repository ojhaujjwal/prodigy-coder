# Context Map

The repository contains separate domain contexts while the runtime-neutral core is being extracted from the existing CLI application.

## Contexts

- [Core](./packages/core/CONTEXT.md) - owns the runtime-neutral agent, tool, session, and execution-authority contracts.
- [CLI](./packages/cli/CONTEXT.md) - owns the current command-line application, its compatibility behavior, and its local runtime policies.

## Relationships

- **CLI -> Core (planned)**: After the core abstraction is accepted, the CLI will adapt its providers, tools, sessions, approvals, and output around the core contracts. This dependency does not describe the current implementation.
- **Core -> execution adapters**: Core defines authority contracts; concrete workspace, process, terminal, remote, and sandbox environments supply implementations outside the core domain.
- **CLI and Core during migration**: Both contexts currently contain similarly named concepts. Names and shapes are not shared domain concepts until the CLI migration establishes an explicit adapter boundary.
- **Future harness**: Ralph-style looping, checks, completion, retry, interruption, and Git policy belong to a future or application-level harness context, not to core or the current CLI glossary.
