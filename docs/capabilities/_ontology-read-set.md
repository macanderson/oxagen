# The ontology read set

The graph reads an agent reasons with, declared in one place so that losing one
cannot go unnoticed.

`ONTOLOGY_READ_CAPABILITIES` in `packages/agent/src/runtime/ontology-tools.ts`
is the canonical list. This page covers what the list is for and how a run asks
for it; each capability is documented on its own page.

## The set

| Capability | Reference | Role in the set |
|---|---|---|
| `query_ontology` | [ontology.query](ontology.query.md) | Typed multi-hop traversal |
| `get_ontology_neighbors` | [ontology.neighbors](ontology.neighbors.md) | One-hop neighborhood of a node |
| `search_graph` | [graph.search](graph.search.md) | Semantic search over eligible shared context |
| `search_nodes` | [graph.node.search](graph.node.search.md) | Text search over nodes |
| `get_node` | [graph.node.get](graph.node.get.md) | One node by `publicId` |
| `list_nodes` | [graph.node.list](graph.node.list.md) | Paginated browse with filters |
| `get_node_labels` | [graph.node_label.get](graph.node_label.get.md) | A node's labels |
| `get_graph_stats` | [graph.stats](graph.stats.md) | Aggregate node and edge counts |

Traversal needs a start node, which is why the lookup half travels with it. An
agent holding `query_ontology` alone cannot use it: that capability requires a
`startNodeId` it has no way to find.

## How a run asks for it

A run that declares no tool allowlist already materializes every capability
carrying the `agent` surface, the graph reads among them. It needs no opt-in,
and `toolPolicy.ontology` is inert there.

A run that narrows itself with `toolPolicy.allowlist` gets only the names it
spells. `toolPolicy.ontology: true` unions the set into that allowlist:

```json
{
  "version": 1,
  "instruction": "Which services depend on the auth service?",
  "toolPolicy": { "allowlist": ["get_execution_trace"], "ontology": true }
}
```

The flag defaults off. An allowlist that silently grew these capabilities would
not be an allowlist, so an enqueuer that wants its agent to reason over the
business graph says so.

## What the flag does not do

It opens no second path to the graph. These are capability *names*; what turns
one into an answer is the `materializeTools` → `invoke()` path every other
capability takes, where IAM, billing admission, the entitlement gate, the
decision-rules gate and `runInTenantScope` all run. The agent engine holds no
graph credential of its own, and every read is attributed to the run's own
identity.

## What keeps the set read-only

`assertOntologyReadOnly` rejects a member that is no longer registered, that
fails to declare `mutates: false`, that is risk-shaped (destructive
sensitivity, high agent risk, or `requiresApproval`), or whose name leads with a
verb that does not read. The set is auto-granted, so a member that has become
dangerous fails closed instead of being taken at its word.
