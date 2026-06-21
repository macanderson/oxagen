# Spec: handlers-skills

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: packages/handlers/src/skill*.ts (11 files)
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: User must be authenticated to edit skill
<!-- id: skillEditHandler -->
<!-- entities: User, Skill -->
<!-- enforced: skillEditHandler() -->

The skill.edit operation requires an authenticated user. If no userId is present in the context, the handler SHALL reject the request with an error.

#### Scenario: Authenticated user edits skill
<!-- test: skillEditHandler.test.ts::it("returns correct shape on success") -->
- **WHEN** an authenticated user (userId present) submits skill.edit with valid .skill.md body
- **THEN** returns { version_id, version_number, skill_id, activated }

#### Scenario: Anonymous request rejected
<!-- test: skillEditHandler.test.ts::it("throws when no authenticated user") -->
- **WHEN** a request without userId calls skill.edit
- **THEN** throws error containing "authenticated user"

---

### Requirement: Create immutable skill version on edit
<!-- id: createNewSkillVersion -->
<!-- entities: Skill, SkillVersion -->
<!-- depends_on: Resolve skill by ID and workspace -->
<!-- triggers: Optionally activate version -->
<!-- enforced: createNewSkillVersion() -->

When a skill is edited, a NEW immutable skill_versions row SHALL be created with versionNumber = max(prior versionNumber) + 1. Prior version rows SHALL NEVER be modified except to clear is_latest. The new version is inserted within a single tenant-scoped transaction.

#### Scenario: Version number increments monotonically
<!-- test: skillEditHandler.test.ts::it("delegates to the same shared codepath as upload") -->
- **WHEN** createNewSkillVersion is called for a skill with existing versions
- **THEN** new version number = max prior + 1, and is_latest flag set true on new row

#### Scenario: Frontmatter parsing required
<!-- test: skillEditHandler.test.ts::it("throws when body is not valid .skill.md") -->
- **WHEN** skill.edit is called with body lacking valid YAML frontmatter
- **THEN** throws error before touching the database

#### Scenario: Schema validation on frontmatter
<!-- test: skillEditHandler.test.ts::it("throws when body frontmatter fails schema validation") -->
- **WHEN** skill.edit is called with frontmatter missing required fields (name, description)
- **THEN** throws error before touching the database

---

### Requirement: Prior latest version flag is cleared atomically
<!-- id: createNewSkillVersion -->
<!-- entities: SkillVersion -->
<!-- enforced: createNewSkillVersion() -->

When a new version is inserted, is_latest SHALL be set to false on the prior latest version within the SAME transaction (before inserting the new version). The partial unique index on skill_versions (WHERE is_latest = true) enforces exactly one is_latest per skill. Clearing must occur first within the transaction to maintain this invariant.

#### Scenario: Clear is_latest before insert
- **WHEN** createNewSkillVersion executes
- **THEN** update skillVersions set is_latest=false BEFORE insert of new version row

#### Scenario: Idempotent after concurrent insert
- **WHEN** multiple createNewSkillVersion calls race on same skill
- **THEN** only one succeeds; losing call hits the partial-unique-index constraint on insert

---

### Requirement: Skill.edit optionally activates the new version
<!-- id: createNewSkillVersion -->
<!-- entities: Skill, SkillVersion -->
<!-- enforced: createNewSkillVersion() -->

When skill.edit is called with activate=true (default for skill.edit), the skill's active_version_id SHALL be updated to the new version's ID and audit columns (activatedByUserId, activatedAt, updatedByUserId, updatedAt) SHALL be set. When activate=false, the skill row SHALL NOT be updated.

#### Scenario: Activate true updates skill row
<!-- test: skillEditHandler.test.ts::it("returns correct shape on success") -->
- **WHEN** skill.edit called with activate=true (default)
- **THEN** returns activated=true and updates skills.active_version_id

#### Scenario: Activate false skips skill row update
<!-- test: skillEditHandler.test.ts::it("does NOT update active_version_id when activate=false") -->
- **WHEN** skill.edit called with activate=false
- **THEN** returns activated=false and does NOT call UPDATE on skills table

#### Scenario: Immutability preserved even when activate=false
<!-- test: skillEditHandler.test.ts::it("immutability: does not attempt to modify any prior version rows") -->
- **WHEN** skill.edit called with activate=false
- **THEN** is_latest clear on prior version STILL executes; only skills table update is skipped

---

### Requirement: Skill.version.upload uses same versioning logic as skill.edit
<!-- id: skillVersionUploadHandler -->
<!-- entities: Skill, SkillVersion, User -->
<!-- enforced: skillVersionUploadHandler() -->

skill.version.upload and skill.edit share the same createNewSkillVersion codepath. Both require an authenticated user, create immutable versions, and optionally activate. The only difference is the entry point name.

#### Scenario: Authenticated user uploads version
<!-- test: skillVersionUploadHandler.test.ts (sample - inferred) -->
- **WHEN** authenticated user calls skill.version.upload with valid .skill.md and activate flag
- **THEN** delegates to createNewSkillVersion; returns { version_id, version_number, skill_id, activated }

#### Scenario: Anonymous upload rejected
- **WHEN** skill.version.upload called without userId
- **THEN** throws "skill.version.upload requires an authenticated user"

---

### Requirement: Skill must exist and be scoped to tenant workspace
<!-- id: createNewSkillVersion -->
<!-- entities: Skill, Org, Workspace -->
<!-- enforced: createNewSkillVersion() -->

When creating a new version, the skill SHALL be resolved by (publicId, orgId, workspaceId) with soft-delete check (deletedAt IS NULL). If the skill is not found in this tenant scope, SHALL throw error. This applies to all version-creation paths: skill.edit, skill.version.upload.

#### Scenario: Skill found in correct workspace
- **WHEN** createNewSkillVersion called for skill in user's workspace
- **THEN** proceeds to version creation

#### Scenario: Skill not found in workspace
<!-- test: skillEditHandler.test.ts::it("throws when skill not found in tenant scope") -->
- **WHEN** createNewSkillVersion called for non-existent skill ID
- **THEN** throws "skill not found" error

#### Scenario: Tenant isolation enforced
- **WHEN** createNewSkillVersion called with skillId from different org/workspace
- **THEN** skill resolution query returns empty; throws error

---

### Requirement: Activate target version by version number
<!-- id: skillVersionActivateHandler -->
<!-- entities: Skill, SkillVersion -->
<!-- enforced: skillVersionActivateHandler() -->

skill.version.activate SHALL resolve the skill and target version by (skillId publicId, versionNumber) within the caller's workspace. It SHALL update the skill's activeVersionId to the target version's ID and set audit columns (activatedByUserId, activatedAt, updatedAt, updatedByUserId).

#### Scenario: Valid activation succeeds
- **WHEN** skill.version.activate called with valid skillId and existing versionNumber
- **THEN** skill.activeVersionId updated to target version; returns { skillId, activeVersionNumber, activatedAt }

#### Scenario: Version not found
- **WHEN** skill.version.activate called with non-existent versionNumber
- **THEN** throws error "version {N} not found for skill {id}"

#### Scenario: Skill not found
- **WHEN** skill.version.activate called with non-existent skillId
- **THEN** throws error "skill not found: {id}"

---

### Requirement: Retrieve specific skill version with metadata
<!-- id: skillVersionGetHandler -->
<!-- entities: Skill, SkillVersion -->
<!-- enforced: skillVersionGetHandler() -->

skill.version.get SHALL resolve skill by publicId, then resolve version by publicId (scoped to the skill and workspace). It SHALL return full version body, YAML frontmatter (extracted and parsed), isLatest flag, and isActive flag (computed by comparing version.id to skill.activeVersionId). Frontmatter is extracted via regex /^---\s*\n([\s\S]*?)\n---\s*\n/ and parsed as YAML.

#### Scenario: Retrieve version with metadata
- **WHEN** skill.version.get called with valid skill_id and version_id
- **THEN** returns { id, skill_id, versionNumber, isLatest, isActive, body, frontmatter, referencesPayload, createdAt, createdBy }

#### Scenario: Extract and parse frontmatter
- **WHEN** version body contains valid YAML frontmatter
- **THEN** frontmatter extracted via regex and returned as parsed YAML object

#### Scenario: Missing frontmatter returns empty object
- **WHEN** version body has no YAML frontmatter block
- **THEN** frontmatter field is empty object {}

#### Scenario: Compute isActive from activeVersionId
- **WHEN** version.id === skill.activeVersionId
- **THEN** isActive = true; otherwise false

#### Scenario: Skill not found
<!-- test: skillVersionGetHandler.test.ts (inferred) -->
- **WHEN** skill.version.get called with non-existent skill_id
- **THEN** logs warning and throws "Skill not found: {id}"

#### Scenario: Version not found
- **WHEN** skill.version.get called with version_id not matching skill
- **THEN** logs warning and throws "Skill version not found: {id}"

---

### Requirement: List skill versions paginated, newest first
<!-- id: skillVersionListHandler -->
<!-- entities: Skill, SkillVersion -->
<!-- enforced: skillVersionListHandler() -->

skill.version.list SHALL list all versions for a skill, paginated (limit default 20, offset default 0), ordered by versionNumber descending (newest first). It SHALL also return total count of all versions for the skill. Returns empty list if skill not found (no error).

#### Scenario: List all versions with pagination
- **WHEN** skill.version.list called with skill_id, limit, offset
- **THEN** returns { skill_id, versions: [...], total } with versions ordered newest first

#### Scenario: Default pagination
- **WHEN** skill.version.list called without limit/offset
- **THEN** limit defaults to 20, offset defaults to 0

#### Scenario: Compute isActive for each version
- **WHEN** version.id === skill.activeVersionId
- **THEN** isActive = true for that version in response

#### Scenario: Skill not found returns empty list
<!-- test: skillVersionListHandler.test.ts (inferred) -->
- **WHEN** skill.version.list called with non-existent skill_id
- **THEN** logs warning and returns { skill_id, versions: [], total: 0 }

---

### Requirement: Export skill version as .skill.md file
<!-- id: skillExportHandler -->
<!-- entities: Skill, SkillVersion -->
<!-- enforced: skillExportHandler() -->

skill.export SHALL serialize a skill version back to `.skill.md` format. It SHALL fallback through three precedence rules: (1) if versionNumber specified, use that; (2) else if skill.activeVersionId set, use active version; (3) else use latest version (isLatest=true). Output is YAML frontmatter (name, description single-quoted) + body, with filename = "{slug}.skill.md".

#### Scenario: Export specific version by number
- **WHEN** skill.export called with versionNumber
- **THEN** exports that version regardless of activeVersionId or isLatest

#### Scenario: Fallback to active version
- **WHEN** skill.export called without versionNumber and activeVersionId is set
- **THEN** exports active version

#### Scenario: Fallback to latest version
- **WHEN** skill.export called without versionNumber and activeVersionId is null
- **THEN** exports latest version (isLatest=true)

#### Scenario: Frontmatter escaping
- **WHEN** skill.export encounters single quote in name or description
- **THEN** escapes as '' (YAML single-quoted scalar rule); does NOT require YAML dep

#### Scenario: Skill not found
- **WHEN** skill.export called with non-existent skillId
- **THEN** throws "Skill not found: {id}"

#### Scenario: Version not found
- **WHEN** skill.export called with version not in skill's history
- **THEN** throws error

---

### Requirement: Install builtin or custom skill into workspace
<!-- id: skillWorkspaceInstallHandler -->
<!-- entities: Skill, SkillVersion, Workspace, Org -->
<!-- enforced: skillWorkspaceInstallHandler() -->

skill.workspace.install SHALL install a skill (builtin from filesystem registry, or custom from caller) into a workspace. It SHALL be idempotent: if a skill with the same slug already exists (not soft-deleted), return it without re-inserting. For new installs, insert skills row (source, installedFromSlug), insert skillVersions v1 row (isLatest=true, versionNumber=1), and back-fill activeVersionId.

#### Scenario: Install builtin skill
- **WHEN** skill.workspace.install called with slug for builtin template
- **THEN** loads from filesystem registry; inserts skill + v1; returns { publicId, slug, activeVersion=1, installed=true }

#### Scenario: Install custom skill
- **WHEN** skill.workspace.install called with custom.name + custom.body
- **THEN** slugifies custom.name (lowercase, trim, replace spaces with hyphens); inserts skill + v1; returns { publicId, slug, activeVersion=1, installed=true }

#### Scenario: Idempotent on re-install
- **WHEN** skill.workspace.install called twice for same slug
- **THEN** first call installed=true; second call installed=false, returns existing publicId + slug

#### Scenario: Builtin template not found
- **WHEN** skill.workspace.install called with non-existent slug
- **THEN** throws error mentioning builtin template not found

#### Scenario: XOR constraint on slug vs custom
- **WHEN** skill.workspace.install called with both slug and custom
- **THEN** throws error "Either `slug` (builtin template) or `custom` must be provided"

#### Scenario: XOR constraint on slug vs custom (neither)
- **WHEN** skill.workspace.install called with neither slug nor custom
- **THEN** throws error "Either `slug` (builtin template) or `custom` must be provided"

#### Scenario: Workspace scope required
- **WHEN** skill.workspace.install called without workspaceId in context
- **THEN** throws error "workspaceId is required (scoped capability)"

---

### Requirement: List installed skills in workspace
<!-- id: skillWorkspaceListHandler -->
<!-- entities: Skill, Workspace -->
<!-- enforced: skillWorkspaceListHandler() -->

skill.workspace.list SHALL return all non-deleted skills in the caller's workspace. It returns name, description (empty string if null), and enabled flag for each skill.

#### Scenario: List all workspace skills
- **WHEN** skill.workspace.list called
- **THEN** returns { skills: [{ id, name, description, enabled }, ...] }

#### Scenario: Empty workspace returns empty list
- **WHEN** skill.workspace.list called on workspace with no skills
- **THEN** returns { skills: [] }

#### Scenario: Soft-deleted skills excluded
- **WHEN** skill has deletedAt set
- **THEN** not included in response

---

### Requirement: Seed new workspace with default builtin skills
<!-- id: seedWorkspaceDefaultSkills -->
<!-- entities: Skill, SkillVersion, Workspace, Org -->
<!-- enforced: seedWorkspaceDefaultSkills() -->

When a workspace is created, seedWorkspaceDefaultSkills SHALL install workspace-owned editable copies of all builtin skill templates. Identity is anchored to (workspace_id, slug), so repeated calls are fully idempotent via ON CONFLICT DO NOTHING at the DB level. Each template becomes a skills row (source='tenant', installed_from_slug=<template slug>) plus skillVersions v1 row with activeVersionId back-filled. Returns { scanned, inserted } counts.

#### Scenario: Seed new workspace
- **WHEN** workspace created and seedWorkspaceDefaultSkills called
- **THEN** scans *.skill.md from filesystem; inserts new skills rows + v1 versions; returns { scanned, inserted > 0 }

#### Scenario: Idempotent on re-run
- **WHEN** seedWorkspaceDefaultSkills called twice for same workspace
- **THEN** first run inserted > 0; second run inserted = 0

#### Scenario: Run inside caller transaction
- **WHEN** seedWorkspaceDefaultSkills called with tx parameter
- **THEN** participates in caller's transaction; does NOT open new withTenantDb session

#### Scenario: Run standalone
- **WHEN** seedWorkspaceDefaultSkills called without tx parameter
- **THEN** opens fresh withTenantDb session; commits independently

#### Scenario: Concurrent insert safety
- **WHEN** two seedWorkspaceDefaultSkills calls race on same workspace/slug
- **THEN** both see "already exists" check or ON CONFLICT; only one row persists

---

### Requirement: Read skill usage metrics from dual sources
<!-- id: skillMetricsReadHandler -->
<!-- entities: Skill, SkillVersion -->
<!-- enforced: skillMetricsReadHandler() -->

skill.metrics.read aggregates usage metrics from Postgres (skills table denormalized: usageCount, lastUsedAt, activeVersionId) and ClickHouse (skill_loads table per-version load counts via readSkillMetrics). Metrics are scoped to workspace. ClickHouse is best-effort; handler logs warning and returns metrics on ClickHouse unavailability. approxTokenCost is null (OXA-1750 phase 2 pending token_usage join).

#### Scenario: Read metrics for single skill
- **WHEN** skill.metrics.read called with skillId
- **THEN** returns { skills: [{ skillId, slug, activeVersion, usageCount, lastUsedAt, approxTokenCost, perVersionLoads }] }

#### Scenario: Read metrics for all workspace skills
- **WHEN** skill.metrics.read called without skillId
- **THEN** returns { skills: [...] } for all workspace skills

#### Scenario: ClickHouse unavailable handled gracefully
- **WHEN** ClickHouse query fails
- **THEN** logs warning; returns metrics with perVersionLoads=[] for each skill; does NOT throw

#### Scenario: Batch resolve active version numbers
- **WHEN** multiple skills have activeVersionId set
- **THEN** resolve versionNumber via single batch query (inArray); O(1) lookup in response assembly

#### Scenario: Per-version load counts indexed
- **WHEN** ClickHouse returns multiple versions per skill
- **THEN** assembled into perVersionLoads array: [{ version, loads, lastUsed }, ...]

---

### Invariant: Tenant isolation enforced on all skill operations
<!-- entities: Skill, SkillVersion, Org, Workspace -->
<!-- enforced: createNewSkillVersion(), skillVersionActivateHandler(), skillVersionGetHandler(), skillVersionListHandler(), skillExportHandler(), skillWorkspaceInstallHandler(), skillWorkspaceListHandler(), skillMetricsReadHandler() -->

Every handler that reads or writes skill data SHALL enforce tenant scoping via (orgId, workspaceId) in WHERE clauses. A user in one workspace SHALL NOT be able to read, modify, or list skills from another workspace or organization.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Partial unique index on skill_versions (is_latest) enforces one latest per skill
<!-- entities: SkillVersion -->
<!-- enforced: createNewSkillVersion() -->

The database index `UNIQUE (skill_id) WHERE is_latest = true` constrains exactly one is_latest=true per skill. createNewSkillVersion clears is_latest on the prior latest BEFORE inserting the new version to maintain this invariant within a single transaction.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Skill versions are immutable after creation
<!-- entities: SkillVersion -->
<!-- enforced: createNewSkillVersion() -->

Once a skill_versions row is inserted, it SHALL NEVER be modified. Prior versions' is_latest flag is cleared, but no other columns are changed. Version history is append-only.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Version number sequence is monotonically increasing per skill
<!-- entities: SkillVersion, Skill -->
<!-- enforced: createNewSkillVersion() -->

For each skill, versionNumber SHALL always increment by exactly 1 from the prior maximum. The sequence starts at 1 and has no gaps.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: All skill database operations scoped to workspace within tenant
<!-- entities: Skill, Workspace -->
<!-- enforced: skillWorkspaceInstallHandler(), skillWorkspaceListHandler() -->

skill.workspace.* operations (install, list) are explicitly workspace-scoped and do not accept a skill_id parameter. They operate only on skills in ctx.workspaceId.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Built-in skill registry path is consistent across all handlers
<!-- entities: Skill -->
<!-- enforced: skillWorkspaceInstallHandler(), seedWorkspaceDefaultSkills() -->

Both skillWorkspaceInstallHandler and seedWorkspaceDefaultSkills load builtin templates from the same filesystem directory (SKILLS_DIR = join(__filename, "../../../../skills/skills")) to ensure they always see the same template set.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: Metrics behavior on ClickHouse outage could potentially mask data loss; no fallback aggregation strategy documented beyond logging warning. approxTokenCost field is stubbed null pending OXA-1750 phase 2 token_usage join (token_usage not yet joined in ClickHouse query). -->
