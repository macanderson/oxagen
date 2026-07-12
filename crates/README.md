# Open Context Protocol (OCP)

The reference implementation of the **Open Context Protocol** — the wire
protocol an agent host uses to discover context providers, negotiate
capabilities, route context queries, and budget / cite / gate what returns.

| Crate | What it is |
|-------|-----------|
| [`ocp-types`](ocp-types) | The wire types. MIT-licensed, zero dependencies beyond `serde`, publishable to crates.io on its own so a third party can implement an OCP host or provider without pulling in any Oxagen code. |
| [`ocp-host`](ocp-host) | The host runtime: provider discovery, capability negotiation, query routing, budgeting, citation, and egress gating. |
| [`ocp-conformance`](ocp-conformance) | The conformance suite plus the `ocp-inspect` and `ocp-example-docs` binaries. |

Spec: `docs/specs/oxagen-rust-cli/06-context-protocol.md`.

> **Note:** the Stella terminal coding agent that previously shared this
> workspace has been ejected to its own public repository,
> [`oxageninc/stella-cli`](https://github.com/oxageninc/stella-cli). This
> workspace now holds only the OCP protocol crates.
