-- Retire the client-authored graph mutation surface and its dependent
-- file-lineage read capability.
--
-- Capability metadata lives in code rather than a database table, so removing
-- a contract does not automatically revoke grants seeded into existing
-- tenants. Delete those grants explicitly. Access-request rows are audit
-- history; preserve them, but expire any request that is still actionable.

UPDATE "iam"."access_requests"
SET status = 'expired', updated_at = now()
WHERE status = 'pending'
  AND capability_id IN (
    'push_graph',
    'graph.sync.push',
    'get_execution_lineage',
    'agent.execution.lineage',
    'run_cypher',
    'graph.cypher',
    'upsert_node',
    'graph.node.upsert',
    'upsert_edge',
    'graph.edge.upsert',
    'upsert_graph_relationship',
    'graph.relationship.upsert',
    'delete_node',
    'graph.node.delete',
    'delete_edge',
    'graph.edge.delete',
    'add_node_label',
    'graph.node_label.add',
    'remove_node_label',
    'graph.node_label.remove',
    'ingest_graph',
    'graph.ingest',
    'infer_semantic_edges',
    'semantic.edge.infer',
    'approve_semantic_edge',
    'semantic.edge.approve',
    'list_semantic_edges',
    'semantic.edge.list',
    'suggest_semantic_edges',
    'semantic.edge.suggest',
    'get_code_map',
    'code.map',
    'export_graph',
    'graph.export'
  );

DELETE FROM "iam"."role_grants"
WHERE capability_id IN (
    'push_graph',
    'graph.sync.push',
    'get_execution_lineage',
    'agent.execution.lineage',
    'run_cypher',
    'graph.cypher',
    'upsert_node',
    'graph.node.upsert',
    'upsert_edge',
    'graph.edge.upsert',
    'upsert_graph_relationship',
    'graph.relationship.upsert',
    'delete_node',
    'graph.node.delete',
    'delete_edge',
    'graph.edge.delete',
    'add_node_label',
    'graph.node_label.add',
    'remove_node_label',
    'graph.node_label.remove',
    'ingest_graph',
    'graph.ingest',
    'infer_semantic_edges',
    'semantic.edge.infer',
    'approve_semantic_edge',
    'semantic.edge.approve',
    'list_semantic_edges',
    'semantic.edge.list',
    'suggest_semantic_edges',
    'semantic.edge.suggest',
    'get_code_map',
    'code.map',
    'export_graph',
    'graph.export'
);
