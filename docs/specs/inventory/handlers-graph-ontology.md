# Spec: handlers-graph-ontology

> **Historical inventory — superseded in part (2026-07-21).** This file was mined
> from a 2026-06-20 implementation snapshot. Sections for generic graph mutation,
> raw Cypher, `get_code_map`, and the full legacy semantic-edge family describe
> retired code and are not current capabilities. Surviving read-only graph and typed ontology paths
> must be verified against source before use.

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: packages/handlers/src/graph.*.ts, ontology.*.ts, semantic.edge.*.ts (14 files)
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Create or update a knowledge graph node

<!-- id: graph.node.upsert.graphNodeUpsertHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.node.upsert.graphNodeUpsertHandler() -->

A node is identified by a stable natural key. When an externalId is provided, the key is `ext:{externalId}`; otherwise, it is the tuple `{label}:{displayName}:{workspaceId}`. The MERGE operation creates the node with orgId, workspaceId, publicId (UUID), label, displayName, description, properties (JSON-encoded), and timestamps (createdAt, updatedAt both set on creation). On match, label, displayName, description, and properties are updated, and updatedAt is refreshed. The response indicates whether the node was newly created.

#### Scenario: Create node with externalId
<!-- test: graphNodeUpsertHandler returns nodeId and created=true on node creation -->
- **WHEN** a node is upser with a unique externalId and no matching node exists
- **THEN** a new KnowledgeNode is created with naturalKey `ext:{externalId}`, a unique publicId is assigned, createdAt and updatedAt are set to the current timestamp, and the response includes nodeId and created=true

#### Scenario: Update existing node without externalId
<!-- test: graphNodeUpsertHandler returns created=false when node already exists -->
- **WHEN** a node upsert is called for a label+displayName+workspaceId tuple that matches an existing node
- **THEN** the existing node is updated (label, displayName, description, properties overwritten), updatedAt is refreshed, and the response includes the existing nodeId with created=false

#### Scenario: Encode properties as JSON
<!-- test: graphNodeUpsertHandler JSON-encodes properties before passing to Cypher -->
- **WHEN** a node upsert includes properties as an object (e.g., `{ role: "engineer", level: 5 }`)
- **THEN** the handler JSON-stringifies the object before passing it to Cypher, and on retrieval the JSON string is parsed back into an object

#### Scenario: Handle missing natural key match
<!-- test: graphNodeUpsertHandler throws when MERGE returns no record -->
- **WHEN** the Neo4j MERGE returns no record (internal Cypher failure)
- **THEN** the handler throws with message "graph.node.upsert: MERGE returned no record"

---

### Requirement: Fetch a single knowledge graph node by publicId

<!-- id: graph.node.get.graphNodeGetHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.node.get.graphNodeGetHandler() -->

A node is fetched by its publicId, scoped by both orgId AND workspaceId to prevent cross-workspace reading (tenant isolation). If the node exists, all properties (publicId, label, displayName, description, properties as parsed JSON, createdAt, updatedAt) are returned. If the node does not exist, null is returned.

#### Scenario: Fetch existing node
<!-- test: graph.node.get handler tests -->
- **WHEN** a node GET request includes a publicId that matches a node in the current org+workspace
- **THEN** the node's full record is returned: publicId, label, displayName, description, properties (parsed from JSON), createdAt, and updatedAt (or null if never modified after creation)

#### Scenario: Node not found
- **WHEN** a node GET request includes a publicId that does not exist in the current org+workspace
- **THEN** the response node field is null

#### Scenario: Tenant isolation — workspaceId scoping
- **WHEN** a node with the same publicId exists in another workspace of the same org
- **THEN** the node is NOT visible — the query scopes by BOTH orgId and workspaceId, preventing cross-workspace leakage

---

### Requirement: List knowledge graph nodes with filtering and pagination

<!-- id: graph.node.list.graphNodeListHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.node.list.graphNodeListHandler() -->

Nodes are listed with optional filters by label, sourceId, and full-text query (case-insensitive substring match on displayName and description). Results are paginated by limit and offset, ordered by creation time (newest first), and include a total count and hasMore flag. Every filter parameter is parameterized (no dynamic Cypher injection). Nodes are scoped by both orgId and workspaceId.

#### Scenario: List all nodes in workspace
<!-- test: graph.node.list handler tests -->
- **WHEN** a list request includes limit and offset with no filters
- **THEN** all nodes in the workspace are returned in descending creation order, along with total count and a hasMore flag based on limit and offset

#### Scenario: Filter by label
- **WHEN** a list request includes labels=['Person', 'Company']
- **THEN** only nodes whose label field matches one of the provided labels are returned

#### Scenario: Filter by sourceId
- **WHEN** a list request includes sourceId='src-123'
- **THEN** only nodes with sourceId='src-123' are returned (or omitted from response if sourceId is null)

#### Scenario: Full-text search in displayName and description
- **WHEN** a list request includes query='TypeScript' (case-insensitive)
- **THEN** only nodes whose displayName or description contains the substring 'TypeScript' (case-insensitive) are returned

#### Scenario: Node labels surface both base and domain type
- **WHEN** nodes are returned, the labels field includes both 'KnowledgeNode' and the domain-specific label (e.g., 'Issue')
- **THEN** the response labels array is ['KnowledgeNode', 'Issue']

---

### Requirement: Search knowledge graph nodes by relevance scoring

<!-- id: graph.node.search.graphNodeSearchHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.node.search.graphNodeSearchHandler() -->

A full-text search queries nodes by a case-insensitive substring match on displayName and description. Results are ranked by a deterministic score: 1.0 if displayName contains the query, 0.75 if both displayName and description match, 0.5 if only description matches. Results are ordered by score (descending) then by displayName (ascending) and limited to a specified count.

#### Scenario: Rank displayName match highest
<!-- test: graph.node.search handler tests -->
- **WHEN** a search for 'Neo4j' finds nodes where only displayName contains 'neo4j'
- **THEN** those nodes are assigned score 1.0 and appear first in results

#### Scenario: Both displayName and description match
- **WHEN** a search finds nodes where both displayName and description contain the query
- **THEN** those nodes are assigned score 0.75

#### Scenario: Only description contains query
- **WHEN** a search finds nodes where only description (not displayName) contains the query
- **THEN** those nodes are assigned score 0.5 and appear last

#### Scenario: Label filtering in search
- **WHEN** a search includes labels=['Topic'] and query='TypeScript'
- **THEN** only nodes with label='Topic' and matching the query are returned

---

### Requirement: Delete a knowledge graph node

<!-- id: graph.node.delete.graphNodeDeleteHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.node.delete.graphNodeDeleteHandler() -->

A node is deleted by publicId, scoped by both orgId and workspaceId. The DETACH DELETE operation removes the node and all its incident relationships atomically. The response indicates whether a node was actually deleted. Deletion is a destructive operation and triggers telemetry emission for audit.

#### Scenario: Delete existing node and its relationships
<!-- test: graph.node.delete handler tests -->
- **WHEN** a delete request targets a publicId that exists in the current org+workspace
- **THEN** the node and all its relationships (RELATED_TO, PART_OF, etc.) are removed in a single atomic transaction, and the response includes deleted=true

#### Scenario: Delete non-existent node
- **WHEN** a delete request targets a publicId that does not exist
- **THEN** no deletion occurs, the response includes deleted=false, and telemetry is still emitted

#### Scenario: Tenant isolation in deletion
- **WHEN** a publicId matches a node in another workspace of the same org
- **THEN** that node is NOT deleted — the query scopes by BOTH orgId and workspaceId

#### Scenario: Telemetry emission
- **WHEN** a node is deleted
- **THEN** deletion telemetry is emitted asynchronously via emitGraphDeletionTelemetry (never blocks the response)

---

### Requirement: Create or update a relationship between knowledge graph nodes

<!-- id: graph.edge.upsert.graphEdgeUpsertHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.edge.upsert.graphEdgeUpsertHandler() -->

A directed relationship (edge) is created or updated between two KnowledgeNodes by fromNodeId and toNodeId. The edgeType (RELATED_TO, PART_OF, CAUSED_BY, REFERENCES, SIMILAR_TO, DEPENDS_ON, CREATED_BY, MENTIONS) is validated against a fixed allow-list. Each edge type has its own static Cypher MERGE template to ensure the query planner sees static relationship types. Properties are JSON-encoded. The composite edgeId is `{fromNodeId}:{edgeType}:{toNodeId}`. The response indicates whether the edge was newly created.

#### Scenario: Create new relationship
<!-- test: graphEdgeUpsertHandler returns composite edgeId and created=true -->
- **WHEN** an edge upsert is called with two existing node IDs and an edgeType (e.g., DEPENDS_ON) and no relationship exists
- **THEN** a new directed relationship is created with createdAt and updatedAt set to the current timestamp, and the response includes edgeId and created=true

#### Scenario: Update existing relationship
<!-- test: graphEdgeUpsertHandler returns created=false on match -->
- **WHEN** an edge upsert is called for a relationship that already exists
- **THEN** the properties are updated, updatedAt is refreshed, and the response includes created=false

#### Scenario: Edge type must be from allowed list
<!-- test: graphEdgeUpsertHandler throws when edge type is unsupported -->
- **WHEN** an unsupported edgeType (e.g., 'INVALID_TYPE') is provided
- **THEN** the handler throws immediately with message listing allowed types before reaching Neo4j

#### Scenario: Both endpoint nodes must exist
<!-- test: graphEdgeUpsertHandler throws when Neo4j returns no record (nodes do not exist) -->
- **WHEN** an edge upsert is called with fromNodeId or toNodeId that do not exist
- **THEN** the Neo4j query returns no record, and the handler throws with message "no record returned — check that both nodes exist"

#### Scenario: Static Cypher query per edge type
<!-- test: graphEdgeUpsertHandler dispatches a static Cypher query for each edge type -->
- **WHEN** edge upserts are called with different edge types (RELATED_TO, PART_OF, etc.)
- **THEN** each edge type dispatches its own static Cypher template (containing the literal relationship type), preventing dynamic Cypher injection

---

### Requirement: Delete a relationship between knowledge graph nodes

<!-- id: graph.edge.delete.graphEdgeDeleteHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.edge.delete.graphEdgeDeleteHandler() -->

A relationship is deleted by fromNodeId, toNodeId, and edgeType. The deletion is scoped by both orgId and workspaceId on both endpoint nodes to prevent cross-workspace leakage. Each edge type has its own static DELETE query template. The response indicates whether a relationship was actually deleted. Deletion triggers telemetry emission.

#### Scenario: Delete existing relationship
<!-- test: graph.edge.delete handler tests -->
- **WHEN** an edge delete is called with fromNodeId, toNodeId, and edgeType that match an existing relationship
- **THEN** the relationship is removed, and the response includes deleted=true

#### Scenario: Delete non-existent relationship
- **WHEN** an edge delete targets a relationship that does not exist
- **THEN** no deletion occurs, the response includes deleted=false, and telemetry is still emitted

#### Scenario: Tenant isolation in edge deletion
- **WHEN** an edge delete targets an edge whose endpoint nodes exist in another workspace of the same org
- **THEN** that edge is NOT deleted — both endpoint nodes are scoped by orgId and workspaceId in the MATCH pattern

#### Scenario: Telemetry emission on edge deletion
- **WHEN** an edge is deleted
- **THEN** deletion telemetry is emitted asynchronously (never blocks the response)

---

### Requirement: Extract and ingest entities and relationships from text

<!-- id: graph.ingest.graphIngestHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.ingest.graphIngestHandler() -->

Text is processed by an LLM to extract entities and relationships. Entities are upser as KnowledgeNodes (idempotent MERGE by label+displayName+workspaceId). Relationships are upsert as edges, but only if both endpoints resolve to a node (no invented relationships). The handler respects type hints and workspace-level graph guidance (read from prompt.settings). Maximum entity count is enforced. Confidence scores (0–1 clamped) are stored in node and edge properties.

#### Scenario: Extract entities with confidence scores
<!-- test: graph.ingest handler tests -->
- **WHEN** text is ingested with maxEntities=10 and entity type hints ['Person', 'Company']
- **THEN** the LLM extracts entities, each entity is upser as a KnowledgeNode with confidence stored in properties, and the response includes created flag for each entity

#### Scenario: Extract relationships only between resolved entities
- **WHEN** an extracted relationship references fromName='Alice' and toName='Charlie', but Charlie was not found in the entities list
- **THEN** the relationship is skipped (not created) — no invented endpoints

#### Scenario: Respect workspace graph guidance
- **WHEN** workspace prompt.settings includes custom graph guidance (e.g., 'Extract ONLY people, not objects')
- **THEN** the extraction prompt includes the guidance, influencing the LLM's decisions

#### Scenario: Handle extraction failures gracefully
- **WHEN** an entity upsert or edge upsert fails during ingestion
- **THEN** the handler logs a warning, continues processing other entities/relationships, and returns partial results

#### Scenario: Sanitize entity types
- **WHEN** extracted entity type is too long (>100 chars) or empty
- **THEN** the type is sanitized: trimmed to 100 chars, or replaced with 'Entity' if empty

---

### Requirement: Execute read-only Cypher queries against the knowledge graph

<!-- id: graph.cypher.graphCypherHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.cypher.graphCypherHandler() -->

The graph.cypher capability supports two modes: raw Cypher and natural-language-to-Cypher. In raw mode, the query string is validated to reject destructive keywords (DROP, DELETE, DETACH DELETE, SET, CREATE, MERGE, REMOVE, CALL apoc.*). In NL mode, an LLM translates the natural-language query to Cypher, then the same safety check is applied. Queries are executed in the tenant scope with orgId and workspaceId injected as parameters. Results are returned as rows with column metadata.

#### Scenario: Execute raw read-only Cypher query
<!-- test: graph.cypher handler tests -->
- **WHEN** a raw Cypher query (nlQuery=false) containing MATCH and RETURN (read-only)
- **THEN** the query is validated, executed, and results are returned as rows with column names

#### Scenario: Translate NL to Cypher with safety guarantee
- **WHEN** a natural-language query is provided (nlQuery=true) and the LLM generates Cypher
- **THEN** the generated Cypher is validated to reject mutations, executed, and results are returned

#### Scenario: Reject destructive keywords in raw mode
- **WHEN** a raw Cypher query contains DELETE or SET
- **THEN** the handler throws with message "does not allow destructive or mutating keywords"

#### Scenario: Reject destructive LLM-generated Cypher
- **WHEN** NL translation produces Cypher with CREATE, MERGE, or APOC mutation keywords
- **THEN** the handler throws the same safety error (belt-and-suspenders validation)

#### Scenario: Inject orgId and workspaceId automatically
- **WHEN** a Cypher query is executed (raw or NL)
- **THEN** $orgId and $workspaceId parameters are automatically bound, ensuring tenant isolation

#### Scenario: Handle large result sets
- **WHEN** a Cypher query would return >50 rows (NL mode) and the user did not request more
- **THEN** results are limited to 50 rows (NL mode applies a default limit; raw mode honors any explicit LIMIT)

---

### Requirement: Compute aggregated statistics about the knowledge graph

<!-- id: graph.stats.graphStatsHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: graph.stats.graphStatsHandler() -->

Graph statistics are computed in the tenant scope: nodeCount, edgeCount, inferredEdgeCount (edges with inferred=true), sourceCount (distinct sourceId values), and lastModifiedAt (most recent updatedAt or createdAt). Optionally, per-label node counts and per-type edge counts are included. On the app surface, a render directive is attached so the chat UI displays stat boxes inline.

#### Scenario: Compute core statistics
<!-- test: graph.stats handler tests -->
- **WHEN** graph statistics are requested for a workspace
- **THEN** the handler returns nodeCount, edgeCount, inferredEdgeCount, sourceCount, and lastModifiedAt for the workspace

#### Scenario: Count inferred edges separately
- **WHEN** graph.stats is called with edges including both standard RELATED_TO and inferred :SEMANTIC_EDGE relationships
- **THEN** inferredEdgeCount includes only edges with inferred=true property

#### Scenario: Optional per-type breakdown
- **WHEN** includeByType=true
- **THEN** nodesByLabel (dict of label → count) and edgesByType (dict of edge type → count) are included in response

#### Scenario: Render directive for app surface
- **WHEN** graph.stats is called with surface='app'
- **THEN** response includes render object with componentId='graph-stats' and props containing all statistics

#### Scenario: No render directive for API/MCP
- **WHEN** graph.stats is called with surface='api' or 'mcp'
- **THEN** response is plain JSON with no render field

---

### Requirement: Traverse the knowledge graph from a start node

<!-- id: ontology.query.ontologyQueryHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: ontology.query.ontologyQueryHandler() -->

A graph traversal starts from a node and follows relationships to a maximum depth (1–5). Direction can be outbound, inbound, or bidirectional. Optionally, specific relationship types are traversed (all types if none specified). The start node and all reached nodes are scoped by orgId and workspaceId. Results include the start node, all reachable nodes (up to a limit, with truncation flag), and all edges along the paths. Nodes are ordered by depth.

#### Scenario: Traverse outbound relationships
<!-- test: ontology.query handler tests -->
- **WHEN** a traversal is initiated from a start node with direction='out', maxDepth=2, and edge types RELATED_TO, PART_OF
- **THEN** all nodes reachable via outbound RELATED_TO or PART_OF edges (up to 2 hops) are returned, along with the edges connecting them, ordered by depth

#### Scenario: Traverse inbound relationships
- **WHEN** direction='in' and maxDepth=3
- **THEN** all nodes from which paths lead TO the start node (inbound direction) are returned up to 3 hops away

#### Scenario: Bidirectional traversal
- **WHEN** direction='both' and maxDepth=2
- **THEN** all nodes reachable via any direction (inbound or outbound) up to 2 hops are returned

#### Scenario: Filter by relationship types
- **WHEN** edgeTypes=['DEPENDS_ON', 'PART_OF'] are specified
- **THEN** only relationships matching those types are traversed

#### Scenario: All relationship types if none specified
- **WHEN** edgeTypes is null or empty
- **THEN** traversal follows any relationship type defined in the graph (RELATED_TO, PART_OF, CAUSED_BY, etc.)

#### Scenario: Enforce node limit and truncation flag
- **WHEN** a traversal result would exceed the node limit
- **THEN** only the first N nodes (by depth) are returned, truncated=true is set, and remaining nodes are omitted

#### Scenario: Tenant isolation in traversal
- **WHEN** a traversal is executed
- **THEN** all nodes and edges are filtered by orgId and workspaceId — a same-publicId node in another workspace is never reachable

---

### Requirement: Fetch immediate neighbors of a knowledge graph node

<!-- id: ontology.neighbors.ontologyNeighborsHandler -->
<!-- entities: KnowledgeNode -->
<!-- enforced: ontology.neighbors.ontologyNeighborsHandler() -->

Neighbors are direct one-hop connections from a node. Direction can be outbound, inbound, or both. Relationship types can be filtered to a subset or default to all allowed types. Results are paginated by limit, ordered by displayName, and include the neighbor node properties and the edge type and direction. A truncation flag indicates if more neighbors exist.

#### Scenario: Fetch outbound neighbors
<!-- test: ontology.neighbors handler tests -->
- **WHEN** a neighbors request includes nodeId='node-1' and direction='out'
- **THEN** all nodes directly connected by outbound edges from 'node-1' are returned, each with edgeType and direction='out'

#### Scenario: Fetch inbound neighbors
- **WHEN** direction='in'
- **THEN** all nodes with outbound edges TO 'node-1' are returned, each with direction='in'

#### Scenario: Fetch both directions
- **WHEN** direction='both'
- **THEN** all one-hop neighbors (inbound and outbound) are returned, with direction field indicating the actual relationship direction

#### Scenario: Filter by relationship types
- **WHEN** edgeTypes=['PART_OF', 'REFERENCES'] are specified
- **THEN** only neighbors connected by those relationship types are returned

#### Scenario: Pagination and truncation
- **WHEN** limit=10 and a node has >10 neighbors
- **THEN** exactly 10 neighbors are returned, truncated=true is set, indicating more exist

#### Scenario: Node not found
- **WHEN** nodeId does not exist in the workspace
- **THEN** found=false is returned, neighbors list is empty, no error is thrown

#### Scenario: Tenant isolation in neighbor fetch
- **WHEN** a neighbors request is executed
- **THEN** only neighbors within the same org+workspace are returned

---

### Requirement: Infer semantic edges from ingested entities asynchronously

<!-- id: semantic.edge.infer.semanticEdgeInferHandler -->
<!-- entities: EntityNode, InferredEdge -->
<!-- enforced: semantic.edge.infer.semanticEdgeInferHandler() -->

The semantic edge inference is initiated asynchronously via Inngest. The handler resolves source connections (data connectors) and filters by sourceIds if provided. An `ingestion/semantic.edge.infer.requested` event is dispatched with the job context. In dry-run mode, a `dry-run` variant event is sent (Neo4j writes are skipped). The handler returns a jobId, status='queued', estimatedNodes count, and dryRun flag immediately.

#### Scenario: Queue inference for all connections
<!-- test: semantic.edge.infer handler tests -->
- **WHEN** semantic.edge.infer is called with sourceIds=null (or empty)
- **THEN** all active source connections in the workspace are resolved, an Inngest event is queued per connection, and the response includes jobId and status='queued'

#### Scenario: Queue inference for specific sources
- **WHEN** sourceIds=['src-1', 'src-2'] are provided
- **THEN** only connections whose publicId matches the sourceIds are included, and Inngest events are queued for those

#### Scenario: No active connections found
- **WHEN** no source connections exist in the workspace (or all are deleted)
- **THEN** no Inngest events are sent, and the response includes status='queued' with estimatedNodes=0

#### Scenario: Dry-run mode
- **WHEN** dryRun=true
- **THEN** the Inngest event is sent to the 'dry-run' variant, and the worker skips Neo4j writes (inference still runs, but results are not persisted)

---

### Requirement: List pending semantic edge suggestions for approval

<!-- id: semantic.edge.suggest.semanticEdgeSuggestHandler -->
<!-- entities: InferredEdge, EntityNode -->
<!-- enforced: semantic.edge.suggest.semanticEdgeSuggestHandler() -->

Pending inferred edges (approvalStatus='pending') are queried by confidence range (confidenceMin, confidenceMax, both optional). Results are ordered by confidence descending and limited. A separate count query returns the total number of matching pending edges. The response includes the suggestions list, total count, and the requested limit.

#### Scenario: List pending edges within confidence band
<!-- test: semantic.edge.suggest handler tests -->
- **WHEN** semantic.edge.suggest is called with confidenceMin=0.7, confidenceMax=0.95
- **THEN** all InferredEdge nodes with approvalStatus='pending' and confidence in [0.7, 0.95] are returned, ordered by confidence descending

#### Scenario: No confidence filter
- **WHEN** confidenceMin and confidenceMax are both null
- **THEN** all pending edges (any confidence) are returned

#### Scenario: Pagination via limit
- **WHEN** limit=5
- **THEN** at most 5 suggestions are returned (total count may be higher)

#### Scenario: Empty suggestions list
- **WHEN** no pending edges match the filters
- **THEN** suggestions=[], total=0

---

### Requirement: Approve or reject a pending semantic edge

<!-- id: semantic.edge.approve.semanticEdgeApproveHandler -->
<!-- entities: InferredEdge, EntityNode, KnowledgeNode -->
<!-- enforced: semantic.edge.approve.semanticEdgeApproveHandler() -->

An InferredEdge with approvalStatus='pending' can be approved or rejected. On rejection, the approvalStatus is updated to 'rejected', an optional comment is attached (audit trail), and no permanent relationship is created. On approval, the approvalStatus becomes 'approved', a target KnowledgeNode is MERGE'd (on orgId+workspaceId+type+name), a permanent :SEMANTIC_EDGE relationship is created from the source EntityNode to the target, and approvedBy (from ctx.userId) and approvedAt are recorded. The response includes the edgeId, decision, and permanentEdgeId (if approved).

#### Scenario: Approve pending edge — create permanent relationship
<!-- test: semanticEdgeApproveHandler approve: updates approvalStatus to approved and creates permanent relationship -->
- **WHEN** a pending InferredEdge is approved
- **THEN** approvalStatus becomes 'approved', approvedBy=userId and approvedAt=now are recorded, a target KnowledgeNode is created or matched, and a permanent :SEMANTIC_EDGE relationship is created linking the source EntityNode to the target, and permanentEdgeId is returned

#### Scenario: Reject pending edge with comment
- **WHEN** a pending InferredEdge is rejected with decision='reject' and comment='low quality'
- **THEN** approvalStatus becomes 'rejected', the comment is stored in the InferredEdge node (audit trail), no permanent relationship is created, and permanentEdgeId is undefined

#### Scenario: Prevent re-decision of already-approved edge
<!-- test: semanticEdgeApproveHandler throws 409 when edge is already approved (not pending) -->
- **WHEN** a decision (approve or reject) is requested for an InferredEdge with approvalStatus='approved' or 'rejected'
- **THEN** the handler throws HTTPException 409 with message "cannot be re-decided"

#### Scenario: Edge not found
<!-- test: semanticEdgeApproveHandler throws 404 when InferredEdge is not found -->
- **WHEN** edgeId does not match any InferredEdge in the workspace
- **THEN** the handler throws HTTPException 404 with message "InferredEdge not found"

#### Scenario: Target node creation on approval
- **WHEN** an approved semantic edge targets a type+name that does not yet exist as a KnowledgeNode
- **THEN** a new KnowledgeNode is MERGE'd with the target type and name, assigned a publicId, and becomes the target of the :SEMANTIC_EDGE relationship

---

### Requirement: List all inferred semantic edges with filtering

<!-- id: semantic.edge.list.semanticEdgeListHandler -->
<!-- entities: InferredEdge, EntityNode, KnowledgeNode -->
<!-- enforced: semantic.edge.list.semanticEdgeListHandler() -->

All InferredEdge nodes (any approvalStatus) are listed with optional filters by relationship type, sourceId (connector), and confidence band. Results are paginated by limit and offset, ordered by confidence descending. A separate count query returns the total matching edges. The response includes edges, total count, limit, and offset.

#### Scenario: List all inferred edges
<!-- test: semantic.edge.list handler tests -->
- **WHEN** semantic.edge.list is called with no filters
- **THEN** all InferredEdge nodes in the workspace (any approvalStatus) are returned in descending confidence order

#### Scenario: Filter by relationship type
- **WHEN** type='IMPLEMENTS' is provided
- **THEN** only InferredEdges with relationshipType='IMPLEMENTS' are returned

#### Scenario: Filter by sourceId (connector)
- **WHEN** sourceId='conn-1' is provided
- **THEN** only InferredEdges with connectionId='conn-1' are returned

#### Scenario: Filter by confidence band
- **WHEN** confidenceMin=0.5 and confidenceMax=0.9 are provided
- **THEN** only InferredEdges with confidence in [0.5, 0.9] are returned

#### Scenario: Pagination
- **WHEN** limit=20 and offset=40
- **THEN** edges at positions 40–59 are returned; total count reflects all matching edges (not just the current page)

#### Scenario: Combine multiple filters
- **WHEN** type, sourceId, and confidence band are all specified
- **THEN** all filters are applied as AND conditions, returning only edges matching all criteria

---

### Invariant: Every node read, written, or deleted is scoped by both orgId and workspaceId

<!-- entities: KnowledgeNode, EntityNode -->
<!-- enforced: graph.node.get.graphNodeGetHandler(), graph.node.upsert.graphNodeUpsertHandler(), graph.node.delete.graphNodeDeleteHandler(), graph.node.list.graphNodeListHandler(), graph.node.search.graphNodeSearchHandler(), ontology.query.ontologyQueryHandler(), ontology.neighbors.ontologyNeighborsHandler() -->

Tenant isolation is non-negotiable. Node operations MATCH or WHERE both `n.orgId = $orgId` AND `n.workspaceId = $workspaceId`. Org-only filtering would allow a node with the same publicId in a sibling workspace to be read, modified, or deleted — a breach of tenant isolation. Every entry point that accesses nodes enforces dual scoping.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Every edge read or deleted is scoped by both orgId and workspaceId on both endpoint nodes

<!-- entities: KnowledgeNode -->
<!-- enforced: graph.edge.delete.graphEdgeDeleteHandler(), graph.edge.upsert.graphEdgeUpsertHandler(), graph.stats.graphStatsHandler(), ontology.query.ontologyQueryHandler(), ontology.neighbors.ontologyNeighborsHandler(), semantic.edge.list.semanticEdgeListHandler(), semantic.edge.suggest.semanticEdgeSuggestHandler() -->

Relationship endpoints (from and to nodes) are independently scoped by orgId and workspaceId. Org-only scoping would allow an edge between same-publicId nodes in a sibling workspace to be accessed or deleted. The MATCH pattern explicitly scopes both endpoints: `(from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})-[r]->(to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})`.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Node natural keys are stable and unambiguous within a workspace

<!-- entities: KnowledgeNode -->
<!-- enforced: graph.node.upsert.graphNodeUpsertHandler() -->

Natural keys are derived from externalId (if provided) or the tuple `{label}:{displayName}:{workspaceId}`. This ensures that the same entity (by external reference or by workspace-local identity) is always MERGE'd to the same node, enabling idempotent ingestion. If externalId is provided, it takes absolute precedence and prevents duplicate nodes with the same external reference.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Properties (node and edge) are JSON-encoded strings in the database, parsed to objects on retrieval

<!-- entities: KnowledgeNode -->
<!-- enforced: graph.node.upsert.graphNodeUpsertHandler(), graph.node.get.graphNodeGetHandler(), graph.node.list.graphNodeListHandler(), graph.edge.upsert.graphEdgeUpsertHandler() -->

When properties are upsert, they are passed to Neo4j as JSON strings (via `JSON.stringify`). On retrieval, they are parsed back to objects (via `JSON.parse`). This allows flexible key-value storage within the graph while maintaining a consistent, strongly-typed API surface.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Edge types are statically validated against a fixed allow-list and dispatched to static Cypher templates

<!-- entities: KnowledgeNode -->
<!-- enforced: graph.edge.upsert.graphEdgeUpsertHandler(), graph.edge.delete.graphEdgeDeleteHandler() -->

Allowed edge types are: RELATED_TO, PART_OF, CAUSED_BY, REFERENCES, SIMILAR_TO, DEPENDS_ON, CREATED_BY, MENTIONS. Each type maps to its own static Cypher query (EDGE_TYPE_QUERIES, EDGE_DELETE_QUERIES). Invalid types are rejected before reaching Neo4j. This prevents Cypher injection via edge-type parameters and ensures the query planner always sees static relationship types.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Raw Cypher queries reject destructive keywords; LLM-generated Cypher is double-validated

<!-- entities: KnowledgeNode -->
<!-- enforced: graph.cypher.graphCypherHandler() -->

The DESTRUCTIVE_PATTERN regex matches DROP, DELETE, DETACH DELETE, SET, CREATE, MERGE, REMOVE, and CALL apoc.* at word boundaries. Raw queries (nlQuery=false) are validated once. LLM-generated queries (nlQuery=true) are validated after LLM generation (belt-and-suspenders: the system prompt instructs the model to emit read-only Cypher, and the handler rejects mutations). Queries that fail validation throw "does not allow destructive or mutating keywords" before execution.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Cypher queries always include orgId and workspaceId parameters for tenant isolation

<!-- entities: KnowledgeNode -->
<!-- enforced: graph.cypher.graphCypherHandler() -->

Every Cypher query executed through graph.cypher includes `$orgId` and `$workspaceId` as bound parameters, even if the user's natural-language query does not explicitly mention them. The system prompt instructs the LLM to inject these filters, and the handler injects them into raw queries as well. This ensures that even untrusted or user-provided queries cannot accidentally leak data across tenant boundaries.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Inferred edge approval is idempotent and irreversible

<!-- entities: InferredEdge, EntityNode, KnowledgeNode -->
<!-- enforced: semantic.edge.approve.semanticEdgeApproveHandler() -->

Once an InferredEdge transitions from 'pending' to 'approved' or 'rejected', it cannot be re-decided. A re-decision attempt throws HTTPException 409. The audit trail (approvedBy, approvedAt, comment) is immutable. On approval, the permanent :SEMANTIC_EDGE relationship is created via MERGE with inferredEdgeId, preventing duplicates if approval is called multiple times.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Semantic edges store confidence as a 0–1 float in the database and in the response

<!-- entities: InferredEdge -->
<!-- enforced: graph.ingest.graphIngestHandler(), semantic.edge.infer.semanticEdgeInferHandler(), semantic.edge.list.semanticEdgeListHandler(), semantic.edge.suggest.semanticEdgeSuggestHandler(), semantic.edge.approve.semanticEdgeApproveHandler() -->

Confidence scores are constrained to [0, 1] at the extraction schema level (via Zod `min(0).max(1)`). When stored in Neo4j, they are preserved as floats. Filtering and sorting operations (e.g., confidenceMin, confidenceMax, ORDER BY confidence) use the stored float value directly.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: graph.ingest entity upsert failure handling is silent (logged warning, processing continues) — no explicit contract guarantees partial-failure behavior to the caller. Test coverage exists but behavior under concurrent failures not fully specified. -->
<!-- uncertainty: semantic.edge.infer is fully async (Inngest-dispatched); this spec captures the synchronous boundary (the handler) only. The actual LLM inference and Neo4j writes happen in a worker process whose behavior is not visible in these source files. -->
