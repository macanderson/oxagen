-- Drop org.grants and org.policies tables (dead schema: zero write paths, read-only stubs)
DROP TABLE IF EXISTS org.policies CASCADE;
DROP TABLE IF EXISTS org.grants CASCADE;

-- Drop unused schema files from codebase
-- execution.ts, integration.ts, workflow-runs.ts, event.ts are comment-only stubs retained for historical reference
-- and will be deleted from packages/database/src/schema/ in the code commit
