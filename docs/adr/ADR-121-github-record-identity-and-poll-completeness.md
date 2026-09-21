# ADR-121: Preserve GitHub record identity across repositories

Status: accepted
Date: 2026-09-19
Related: #2974, absorbed #1265

## Decision

Issue and pull-request numbers identify records within a repository. They cannot identify records across an organization connection. Use the record type and GitHub database ID as the ingestion identity. Prefer a node ID when no database ID is available, then a source URL that includes the repository. Refuse records with none of those identifiers.

Existing graph nodes retain their natural key and public ID only when one legacy node in the workspace has the same record type and source URL. Persist the new canonical key as an alias on that node. Later deliveries use that alias, including after a repository rename. Retaining the node preserves its relationships. Ambiguous legacy rows remain untouched; a resync creates a distinct canonical node instead of overwriting another repository's record.

Organization polling expands visible repositories and reads every page of each list. A failure after the first page fails the read. Each list request has a 30-second timeout. A first-page 404 continues to mean that a repository or endpoint is unavailable.

The shared poll worker must finish collecting a record type before advancing its timestamp cursor. A batch exceeding 200 records fails and retains its previous cursor. This is a visible capacity limit until the worker supports durable continuation. A truncated descending stream cannot safely advance to its maximum timestamp.

## Backfill and limitations

Deploying the code performs no data rewrite or provider calls. A connection resync replays provider records through the compatibility lookup. Rows previously overwritten by a colliding record need a provider backfill to reconstruct the missing entity. Edges whose original destination was overwritten cannot be reconstructed from the surviving row alone.

A legacy row with no stored source URL, an ambiguous duplicate, or a repository renamed before its first compatibility update needs separate reconciliation. URL-only identities cannot survive a rename until a global provider ID has been recorded. A large backfill needs durable continuation before it can finish through the scheduled poll worker; the worker reports failure instead of discarding the remainder.


## Mapped URLs and reconciliation (#3558)

Every new graph write stores `sourceExternalUrl` separately from mapped properties. The compatibility lookup prefers that provenance. For an older node without it, the ingestion builders follow the connection's configured `url` mapping, including chained renames, and compare that one field with the provider record's source URL. A match retains the existing natural key, public ID and relationships while recording the canonical alias.

The lookup never searches arbitrary property values. A changed mapping with no surviving source provenance, a conflicting source URL, or duplicate legacy candidates leaves the canonical record separate. Similarity matching cannot override that identity refusal. The direct pipeline returns `dedup.identityReconciliation` with the candidate public IDs and reason. The durable pipeline logs the same facts at warning level with the connection and canonical record. Operators can use verified historical connection mappings or provider records to reconcile those candidates; a repository-local number alone is insufficient evidence. Deployment performs no speculative historical merge.
