# Linear backlog — foundations capabilities

The four foundation-milestone capabilities below need first-class issues
in the `oxagen-v2` Linear project. The MCP-based subagent that generated
this scaffold did not have Linear access; file these by hand or via the
human's local Linear MCP session.

| Capability                  | Domain        | Mode  | SPEC link                                 |
| --------------------------- | ------------- | ----- | ----------------------------------------- |
| `tenant.create`             | organization  | sync  | `docs/capabilities/tenant.create.md`      |
| `workspace.create`          | workspace     | sync  | `docs/capabilities/workspace.create.md`   |
| `billing.subscription.read` | billing       | sync  | `docs/capabilities/billing.subscription.read.md` |
| `chat.message.send`         | chat          | async | `docs/capabilities/chat.message.send.md`  |

Each issue should:
- Link to the corresponding `docs/capabilities/<name>.md`.
- List the layers it ships (schema, api, mcp, unit, e2e, docs).
- Reference foundations spec `docs/epics/foundations/spec.md` and the
  acceptance criterion the capability satisfies.
