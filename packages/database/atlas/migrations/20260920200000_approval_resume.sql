ALTER TABLE agent.approval_requests
 ADD COLUMN resume_payload jsonb,
 ADD COLUMN resume_key text,
 ADD COLUMN resume_status text,
 ADD COLUMN resume_started_at timestamptz,
 ADD COLUMN resume_finished_at timestamptz,
 ADD COLUMN resume_run_public_id text,
 ADD COLUMN resume_error text,
 ADD CONSTRAINT approval_requests_resume_status_check CHECK (resume_status IS NULL OR resume_status IN ('waiting', 'queued', 'running', 'succeeded', 'dispatched', 'failed', 'indeterminate', 'denied', 'expired'));
CREATE INDEX approval_requests_resume_queue_idx ON agent.approval_requests (resume_status, created_at) WHERE resume_payload IS NOT NULL;
CREATE INDEX approval_requests_resume_key_idx ON agent.approval_requests (workspace_id, resume_key);
