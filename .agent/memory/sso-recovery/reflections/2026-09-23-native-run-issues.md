# Native Run issue providers

GitHub issue writes reuse the verified workspace installation and request a repository-scoped Issues write token. Linear uses a new customer authorization with PKCE, actor-bound single-use state, encrypted rotating tokens, and an explicit issue-only connection marker. Legacy Linear connector credentials cannot be refreshed with this application client ID.

Issue-only connections must be refused by the scheduler, directly dispatched poll and sync jobs, raw ingestion pipeline, and credential resolver. A nullable JSONB replacement must normalize null before concatenating the immutable purpose marker; JSONB null concatenation can otherwise produce an array and erase the effective marker.

The orchestrator persists its selected candidates and first-attempt claim. A provider timeout triggers reconciliation. An empty eventually consistent GitHub search never permits a second POST. Linear gets a deterministic UUID scoped to the candidate and tenant. Prompts use only confirmed receipt links.

Independent source and coverage audit: worktree_recovery accepted the final native-only connection predicates and the callback, issue receipt, and ingestion refusal coverage. Tests are authored but not run locally. Configured hooks and CI remain the execution gates. The provider component still needs the coordinated Run mount. Provider purpose metadata is not a cryptographic provenance claim; general connection editing can currently set arbitrary metadata, a separate hardening item.
