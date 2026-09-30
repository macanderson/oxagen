# list_branches

**Surfaces:** api, mcp

List the branches of a GitHub repository: each branch's name and SHA, whether it is protected, and which one is the default branch. GitHub returns up to 300 branches, three pages of 100, in its default order.

`DEREGISTERED.md` §9 retires this read. The code graph that `link_repository` and `sync_repository` build holds the same facts, and `search_graph`, `expand_graph`, and `query_graph` read them. The contract and its handler stay in the tree.

## Mode

**sync**

## Surfaces

- API: `GET /v1/repos/branches?owner=&repo=` (`apps/api/src/routes/v1/repo.ts`)
- MCP: `list_branches`
- Agent: none. `DEREGISTERED.md` retires this action, so Stella cannot call it (#4180).

## Input

| Field | Type | Required | Description |
|---|---|---|---|
| `owner` | string | yes | Repository owner, a user or an organisation |
| `repo` | string | yes | Repository name |

## Output

| Field | Type | Description |
|---|---|---|
| `branches` | array | Each branch as `{ name, sha, isDefault, protected }` |
| `defaultBranch` | string or null | The default branch's name, or null when GitHub did not report one |

## Roles

Org Owner or Admin, or workspace Owner or Member. `mutates: false`, low sensitivity, IAM default-deny.
