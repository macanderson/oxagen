/**
 * GitHub canonical-snapshot projection lifecycle — shared library.
 *
 * The single home for the commit-addressed projection machinery described in
 * docs/specs/workspace-graph-boundary/spec.md (§"Canonical-ref policy",
 * §"GitHub projection lifecycle"). Postgres (ingestion.code_repositories /
 * repository_snapshots / projection_generations / code_scopes) is the canonical
 * truth; Neo4j is a rebuildable projection written only on activation.
 *
 * The hard rules encoded here:
 *   - Snapshot identity is the immutable commit SHA + tree SHA observed at the
 *     configured default ref — NEVER the moving branch name. resolveCanonicalHead
 *     resolves the ref to a commit; fetchTreeBySha fetches the tree by its SHA.
 *   - A projection generation is staged 'building' and can only become 'active'
 *     once every fanned-out file has reported done (files_processed +
 *     files_skipped >= files_total). No incomplete projection is ever served
 *     (launch invariant 3).
 *   - Activation is atomic and serialized per repository: it locks the
 *     code_repositories row, supersedes any other active generation, flips this
 *     one to active, and advances projected_head_sha — the flip is the LAST
 *     operation, so an Inngest retry re-runs the idempotent Neo4j projection
 *     rather than skipping it.
 *
 * Postgres access follows sibling ingestion functions: raw SQL via
 * withSystemDb (token read, RLS-bypass) / withTenantDb (RLS-enforced projection
 * writes, requires an ambient runInTenantScope). Raw db() is banned.
 */

import { withSystemDb, withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { resolveIngestionCryptoAdapterForKeyId, decrypt } from "@oxagen/crypto";
import {
  projectSnapshotToGraph,
  pruneLegacySourceDetail,
} from "@oxagen/ontology";
import type { ProjectSnapshotScope } from "@oxagen/ontology";

// ── Shared file-selection rules (kept identical to the original initial-sync so
// the fanned-out set is unchanged) ───────────────────────────────────────────
/** Directory prefixes never worth projecting. */
export const EXCLUDED_PREFIXES = [
  "node_modules/",
  "dist/",
  ".git/",
  "__pycache__/",
];
/** Extensions we parse: code (tree-sitter) + markdown docs. */
export const ALLOWED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".py",
  ".md",
  ".mdx",
  ".markdown",
];
/** Cap on files fanned out per generation, bounding parse fan-out. */
export const MAX_FILES = 500;
/**
 * Deterministic parser/projector version stamped on every generation. Bump when
 * the projection semantics change so stale generations are distinguishable.
 */
export const PROJECTION_PARSER_VERSION = "1";

/** Package-manifest basenames that mark a directory as a `package` code scope. */
const MANIFEST_FILES = new Set([
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CanonicalHead {
  commitSha: string;
  treeSha: string;
  parentShas: string[];
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: string; // "blob" | "tree" | "commit"
  sha: string;
  size?: number;
}

export interface TreeResult {
  entries: GitTreeEntry[];
  truncated: boolean;
}

export type ScopeKind = "package" | "service" | "module" | "path";

/** One derived code scope. Structurally compatible with ProjectSnapshotScope. */
export interface ScopeDef {
  scopeKey: string;
  kind: ScopeKind;
  displayName: string;
  domainSlug: string | null;
  fileCount: number;
}

export interface DeriveScopesResult {
  scopes: ScopeDef[];
  /** Every input path → its scope key, for attaching codeScopeId on fan-out. */
  scopeKeyByPath: Record<string, string>;
}

export interface StageGenerationInput {
  orgId: string;
  workspaceId: string;
  provider: string; // "github"
  providerRepoId: string;
  owner: string;
  name: string;
  installationId: string | null;
  sourceConnectionId: string | null;
  /** Full canonical ref, e.g. "refs/heads/main". */
  defaultRef: string;
  commitSha: string;
  treeSha: string;
  parentShas: string[];
  /** Head SHA observed at the default ref (usually === commitSha). */
  observedHeadSha: string;
  /** Count of PARSEABLE files fanned out — the completion-gate denominator. */
  filesTotal: number;
  truncated: boolean;
  parserVersion: string;
  scopes: ScopeDef[];
  /** Snapshot authority level; provider reads are 'provider_observed'. */
  snapshotSource?: "provider_observed" | "runner_observed";
}

export interface StageGenerationResult {
  repositoryId: string;
  snapshotId: string;
  generationId: string;
  /** True when a generation for (repository, snapshot) already existed — the
   *  dedupe-by-after-sha path. Callers skip re-fan-out. */
  alreadyExists: boolean;
  /** scopeKey → code_scopes.id, for stamping codeScopeId on fanned-out files. */
  codeScopeIdByKey: Record<string, string>;
  commitSha: string;
  treeSha: string;
}

export interface ActivateResult {
  activated: boolean;
  generationId: string;
  repositoryId?: string;
  commitSha?: string;
}

// ── GitHub REST helpers ────────────────────────────────────────────────────────

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "oxagen-ingestion/1.0",
  };
}

/**
 * Resolve a governed connection's decrypted GitHub access token by connection
 * id. Extracted from the sibling ingestion functions (initial-sync / parse-file
 * / commit-files) so every projection caller resolves the bearer token the same
 * way. Routes decryption by the envelope's stored keyId so tokens wrapped under
 * a previous INGESTION_CRYPTO_PROVIDER still decrypt.
 */
export async function fetchConnectionAccessToken(
  connectionId: string,
  orgId: string,
): Promise<string> {
  const rows = await withSystemDb(async (tx) => {
    const result = await tx.execute(sql`
      SELECT oa.access_token_enc
      FROM   ingestion.oauth_accounts oa
      JOIN   ingestion.source_connections sc
             ON sc.oauth_account_id = oa.id
      WHERE  sc.id     = ${connectionId}::uuid
      AND    sc.org_id = ${orgId}::uuid
      LIMIT  1
    `);
    return Array.from(result) as Array<{
      access_token_enc: { keyId: string; ciphertext: string } | null;
    }>;
  });

  const row = rows[0];
  if (!row?.access_token_enc) {
    throw new Error(
      `github-projection: no oauth token for connectionId=${connectionId}`,
    );
  }

  const cryptoAdapter = resolveIngestionCryptoAdapterForKeyId(
    row.access_token_enc.keyId,
  );
  const cipherBuf = Buffer.from(row.access_token_enc.ciphertext, "base64");
  const decrypted: unknown = await decrypt(cipherBuf, cryptoAdapter.keyId, {
    adapter: cryptoAdapter.adapter,
  });
  return Buffer.isBuffer(decrypted)
    ? decrypted.toString("utf8")
    : String(decrypted);
}

/**
 * Resolve the configured default ref to its immutable commit + tree SHA. The
 * authoritative read (spec §"Push to the canonical ref" step 4): GET the ref to
 * get the commit SHA, then GET the commit to get its tree + parents. NEVER
 * fetches a tree by branch name.
 */
export async function resolveCanonicalHead(
  installationToken: string,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<CanonicalHead> {
  // Accept either a branch name ("main") or a full ref ("refs/heads/main").
  const branch = defaultBranch.replace(/^refs\/heads\//, "");
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const refResp = await fetch(`${base}/git/ref/heads/${branch}`, {
    headers: ghHeaders(installationToken),
  });
  if (!refResp.ok) {
    throw new Error(
      `github-projection: git/ref/heads/${branch} returned ${refResp.status} for ${owner}/${repo}`,
    );
  }
  const refBody = (await refResp.json()) as { object?: { sha?: string } };
  const commitSha = refBody.object?.sha;
  if (!commitSha) {
    throw new Error(
      `github-projection: no commit sha at heads/${branch} for ${owner}/${repo}`,
    );
  }

  const commitResp = await fetch(`${base}/git/commits/${commitSha}`, {
    headers: ghHeaders(installationToken),
  });
  if (!commitResp.ok) {
    throw new Error(
      `github-projection: git/commits/${commitSha} returned ${commitResp.status} for ${owner}/${repo}`,
    );
  }
  const commitBody = (await commitResp.json()) as {
    tree?: { sha?: string };
    parents?: Array<{ sha?: string }>;
  };
  const treeSha = commitBody.tree?.sha;
  if (!treeSha) {
    throw new Error(
      `github-projection: commit ${commitSha} has no tree sha for ${owner}/${repo}`,
    );
  }
  const parentShas = (commitBody.parents ?? [])
    .map((p) => p.sha)
    .filter((s): s is string => typeof s === "string");

  return { commitSha, treeSha, parentShas };
}

/** One entry from a GitHub commit `compare` file list. */
export interface CompareFile {
  filename: string;
  status: string; // added | modified | removed | renamed | changed | copied
  /** Blob SHA at the head of the compare range. */
  sha?: string;
  /** Prior path for a renamed file (its old canonical identity to remove). */
  previous_filename?: string;
}

/** Compare-file statuses whose file still exists at head → fan out for parsing. */
const FAN_OUT_STATUSES = new Set([
  "added",
  "modified",
  "renamed",
  "changed",
  "copied",
]);

/**
 * GET the commit `compare` between two SHAs (spec §"Push to the canonical ref"
 * step 5 — apply a delta only when the stored head and event ancestry line up).
 */
export async function fetchCompare(
  installationToken: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<CompareFile[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`;
  const resp = await fetch(url, { headers: ghHeaders(installationToken) });
  if (!resp.ok) {
    throw new Error(
      `github-projection: compare ${base}...${head} returned ${resp.status} for ${owner}/${repo}`,
    );
  }
  const body = (await resp.json()) as { files?: CompareFile[] };
  return body.files ?? [];
}

/**
 * Split a compare file list into the parseable files to re-project (added /
 * modified / renamed-to / changed / copied) and the canonical paths to remove
 * (deleted, plus the old path of a rename). Pure.
 */
export function classifyCompareFiles(files: CompareFile[]): {
  fanOut: Array<{ path: string; sha: string }>;
  removed: string[];
} {
  const fanOut: Array<{ path: string; sha: string }> = [];
  const removed: string[] = [];
  for (const f of files) {
    if (f.status === "removed") {
      removed.push(f.filename);
      continue;
    }
    // A rename retires the old path's canonical node.
    if (f.status === "renamed" && f.previous_filename) {
      removed.push(f.previous_filename);
    }
    if (FAN_OUT_STATUSES.has(f.status) && f.sha && isParseablePath(f.filename)) {
      fanOut.push({ path: f.filename, sha: f.sha });
    }
  }
  return { fanOut, removed };
}

/**
 * Fetch the recursive tree by its immutable SHA (spec: never by branch name).
 * `truncated` is surfaced so the generation records partial coverage honestly.
 */
export async function fetchTreeBySha(
  installationToken: string,
  owner: string,
  repo: string,
  treeSha: string,
): Promise<TreeResult> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`;
  const resp = await fetch(url, { headers: ghHeaders(installationToken) });
  if (!resp.ok) {
    throw new Error(
      `github-projection: git/trees/${treeSha} returned ${resp.status} for ${owner}/${repo}`,
    );
  }
  const body = (await resp.json()) as {
    tree?: GitTreeEntry[];
    truncated?: boolean;
  };
  return { entries: body.tree ?? [], truncated: body.truncated === true };
}

/**
 * A tree blob that should be fanned out for parsing (existing include/exclude +
 * extension rules). Excluded files are neither fanned out nor counted in a
 * generation's completion gate.
 */
export function isParseableFile(entry: {
  path: string;
  type: string;
  size?: number;
}): boolean {
  if (entry.type !== "blob") return false;
  if (!entry.size || entry.size === 0) return false;
  return isParseablePath(entry.path);
}

/**
 * Path-only variant of {@link isParseableFile} for callers that lack a tree
 * entry's type/size — e.g. the delta path deriving fan-out from a commit
 * `compare` file list (which carries filename + blob sha but no size).
 */
export function isParseablePath(path: string): boolean {
  if (EXCLUDED_PREFIXES.some((pfx) => path.startsWith(pfx))) return false;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

// ── Scope derivation ──────────────────────────────────────────────────────────

/**
 * Deterministically map every tree path to a stable code scope.
 *
 * A directory containing a package manifest (package.json, go.mod, Cargo.toml,
 * pyproject.toml) is a `package` scope; longest-prefix wins so a file under a
 * nested package binds to the nearest package. Every remaining file maps to its
 * top-level directory as a `path` scope; root-level files map to scope_key "."
 * with displayName "(root)". Pure and order-independent (scopes sorted by key).
 *
 * NOTE: pass the FULL tree path list (not just parseable files) so manifest
 * files — which are not themselves parseable — are seen and their directories
 * become package scopes.
 */
export function deriveScopes(paths: string[]): DeriveScopesResult {
  // 1. Directories that contain a package manifest ("" === repo root).
  const packageDirs = new Set<string>();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const base = slash === -1 ? p : p.slice(slash + 1);
    if (MANIFEST_FILES.has(base)) {
      packageDirs.add(slash === -1 ? "" : p.slice(0, slash));
    }
  }
  // Longest dir first → longest-prefix wins for nested packages.
  const sortedPackageDirs = Array.from(packageDirs).sort(
    (a, b) => b.length - a.length,
  );

  const scopeKeyByPath: Record<string, string> = {};
  const defs = new Map<string, ScopeDef>();

  const bump = (key: string, kind: ScopeKind, displayName: string): void => {
    const existing = defs.get(key);
    if (existing) {
      existing.fileCount += 1;
    } else {
      defs.set(key, {
        scopeKey: key,
        kind,
        displayName,
        domainSlug: null,
        fileCount: 1,
      });
    }
  };

  for (const p of paths) {
    let matchedDir: string | null = null;
    for (const dir of sortedPackageDirs) {
      if (dir === "" || p === dir || p.startsWith(`${dir}/`)) {
        matchedDir = dir;
        break;
      }
    }

    if (matchedDir !== null) {
      const key = matchedDir === "" ? "." : matchedDir;
      const displayName =
        matchedDir === "" ? "(root)" : (matchedDir.split("/").pop() as string);
      scopeKeyByPath[p] = key;
      bump(key, "package", displayName);
    } else {
      const slash = p.indexOf("/");
      if (slash === -1) {
        scopeKeyByPath[p] = ".";
        bump(".", "path", "(root)");
      } else {
        const top = p.slice(0, slash);
        scopeKeyByPath[p] = top;
        bump(top, "path", top);
      }
    }
  }

  const scopes = Array.from(defs.values()).sort((a, b) =>
    a.scopeKey.localeCompare(b.scopeKey),
  );
  return { scopes, scopeKeyByPath };
}

// ── Postgres canonical-truth staging + activation ──────────────────────────────

/**
 * Stage a projection generation for one canonical snapshot in a single
 * withTenantDb transaction (spec §"GitHub projection lifecycle"). Upserts the
 * repository (advancing observed_head_sha / default_ref), reuses the immutable
 * snapshot, and inserts the generation 'building' with its code scopes.
 *
 * Dedupe-by-after-sha: the generation is inserted ON CONFLICT (repository,
 * snapshot) DO NOTHING — if it already existed the function returns the existing
 * ids with `alreadyExists: true` and does not re-insert scopes.
 *
 * Must run inside an ambient runInTenantScope (withTenantDb reads it).
 */
export async function stageGeneration(
  input: StageGenerationInput,
): Promise<StageGenerationResult> {
  const {
    orgId,
    workspaceId,
    provider,
    providerRepoId,
    owner,
    name,
    installationId,
    sourceConnectionId,
    defaultRef,
    commitSha,
    treeSha,
    parentShas,
    observedHeadSha,
    filesTotal,
    truncated,
    parserVersion,
    scopes,
    snapshotSource = "provider_observed",
  } = input;

  return withTenantDb(async (tx) => {
    // 1. Upsert the governed repository row (immutable provider_repo_id key).
    //    projected_head_sha is deliberately NOT touched here — it advances only
    //    on activation.
    const repoRes = Array.from(
      await tx.execute(sql`
        INSERT INTO ingestion.code_repositories
          (org_id, workspace_id, provider, provider_repo_id, owner, name,
           installation_id, source_connection_id, default_ref, observed_head_sha)
        VALUES
          (${orgId}::uuid, ${workspaceId}::uuid, ${provider}, ${providerRepoId},
           ${owner}, ${name}, ${installationId}, ${sourceConnectionId}::uuid,
           ${defaultRef}, ${observedHeadSha})
        ON CONFLICT (org_id, provider, provider_repo_id) DO UPDATE SET
          owner                = EXCLUDED.owner,
          name                 = EXCLUDED.name,
          -- COALESCE so a caller that lacks the installation id (e.g. the
          -- OAuth-token initial sync) never wipes one a webhook already set.
          installation_id      = COALESCE(EXCLUDED.installation_id, ingestion.code_repositories.installation_id),
          source_connection_id = COALESCE(EXCLUDED.source_connection_id, ingestion.code_repositories.source_connection_id),
          default_ref          = EXCLUDED.default_ref,
          observed_head_sha    = EXCLUDED.observed_head_sha,
          updated_at           = NOW()
        RETURNING id
      `),
    ) as Array<{ id: string }>;
    const repositoryId = repoRes[0]!.id;

    // 2. Insert the immutable snapshot; reuse on (repository, commit) conflict.
    const snapRes = Array.from(
      await tx.execute(sql`
        INSERT INTO ingestion.repository_snapshots
          (org_id, workspace_id, repository_id, commit_sha, tree_sha, parent_shas, source)
        VALUES
          (${orgId}::uuid, ${workspaceId}::uuid, ${repositoryId}::uuid,
           ${commitSha}, ${treeSha}, ${JSON.stringify(parentShas)}::jsonb, ${snapshotSource})
        ON CONFLICT (repository_id, commit_sha) DO NOTHING
        RETURNING id
      `),
    ) as Array<{ id: string }>;
    let snapshotId: string;
    if (snapRes[0]) {
      snapshotId = snapRes[0].id;
    } else {
      const ex = Array.from(
        await tx.execute(sql`
          SELECT id FROM ingestion.repository_snapshots
          WHERE repository_id = ${repositoryId}::uuid AND commit_sha = ${commitSha}
          LIMIT 1
        `),
      ) as Array<{ id: string }>;
      snapshotId = ex[0]!.id;
    }

    // 3. Insert the generation 'building'; dedupe on (repository, snapshot).
    const genRes = Array.from(
      await tx.execute(sql`
        INSERT INTO ingestion.projection_generations
          (org_id, workspace_id, repository_id, snapshot_id, status,
           files_total, truncated, parser_version)
        VALUES
          (${orgId}::uuid, ${workspaceId}::uuid, ${repositoryId}::uuid, ${snapshotId}::uuid,
           'building', ${filesTotal}, ${truncated}, ${parserVersion})
        ON CONFLICT (repository_id, snapshot_id) DO NOTHING
        RETURNING id
      `),
    ) as Array<{ id: string }>;

    if (!genRes[0]) {
      // Already staged for this snapshot — return the existing ids untouched.
      const exGen = Array.from(
        await tx.execute(sql`
          SELECT id FROM ingestion.projection_generations
          WHERE repository_id = ${repositoryId}::uuid AND snapshot_id = ${snapshotId}::uuid
          LIMIT 1
        `),
      ) as Array<{ id: string }>;
      const generationId = exGen[0]!.id;
      const existingScopes = Array.from(
        await tx.execute(sql`
          SELECT id, scope_key FROM ingestion.code_scopes
          WHERE generation_id = ${generationId}::uuid
        `),
      ) as Array<{ id: string; scope_key: string }>;
      const codeScopeIdByKey: Record<string, string> = {};
      for (const r of existingScopes) codeScopeIdByKey[r.scope_key] = r.id;
      return {
        repositoryId,
        snapshotId,
        generationId,
        alreadyExists: true,
        codeScopeIdByKey,
        commitSha,
        treeSha,
      };
    }

    const generationId = genRes[0].id;

    // 4. Insert the code scopes; build scopeKey → id for fan-out attribution.
    const codeScopeIdByKey: Record<string, string> = {};
    for (const s of scopes) {
      const scRes = Array.from(
        await tx.execute(sql`
          INSERT INTO ingestion.code_scopes
            (org_id, workspace_id, repository_id, generation_id, scope_key,
             kind, display_name, domain_slug, file_count)
          VALUES
            (${orgId}::uuid, ${workspaceId}::uuid, ${repositoryId}::uuid, ${generationId}::uuid,
             ${s.scopeKey}, ${s.kind}, ${s.displayName}, ${s.domainSlug ?? null}, ${s.fileCount})
          RETURNING id
        `),
      ) as Array<{ id: string }>;
      codeScopeIdByKey[s.scopeKey] = scRes[0]!.id;
    }

    return {
      repositoryId,
      snapshotId,
      generationId,
      alreadyExists: false,
      codeScopeIdByKey,
      commitSha,
      treeSha,
    };
  });
}

/**
 * Activate a generation once, and only once, it is complete
 * (files_processed + files_skipped >= files_total, status 'building').
 *
 * Ordering is load-bearing (see the module header): the idempotent Neo4j
 * projection (Repository/RepositorySnapshot/CodeScope topology + one-time legacy
 * cleanup) runs FIRST, then a single serialized transaction locks the
 * repository row, re-checks the gate, supersedes every other active generation,
 * flips this one to active, and advances projected_head_sha. Because the flip is
 * the last operation, an Inngest retry that dies in Neo4j simply re-runs the
 * idempotent MERGE and re-attempts the flip — the projection is never skipped.
 *
 * Concurrency-safe for the hundreds of generation-file-done events that race to
 * complete the same generation: the repository-row lock serializes them and the
 * status='building' re-check lets exactly one win.
 *
 * Must run inside an ambient runInTenantScope (withTenantDb + the ontology
 * mutations read it).
 */
export async function activateGenerationIfComplete(
  generationId: string,
): Promise<ActivateResult> {
  // 1. Cheap gate read — the common case (a non-final file finishing) exits here.
  const gen = await withTenantDb(async (tx) => {
    const rows = Array.from(
      await tx.execute(sql`
        SELECT status, files_total, files_processed, files_skipped,
               repository_id, snapshot_id
        FROM ingestion.projection_generations
        WHERE id = ${generationId}::uuid
      `),
    ) as Array<{
      status: string;
      files_total: number;
      files_processed: number;
      files_skipped: number;
      repository_id: string;
      snapshot_id: string;
    }>;
    return rows[0] ?? null;
  });

  if (!gen) return { activated: false, generationId };
  const complete =
    Number(gen.files_processed) + Number(gen.files_skipped) >=
    Number(gen.files_total);
  if (gen.status !== "building" || !complete) {
    return { activated: false, generationId };
  }

  // 2. Load the repository, snapshot, and scopes for the graph projection.
  const proj = await withTenantDb(async (tx) => {
    const repoRows = Array.from(
      await tx.execute(sql`
        SELECT provider_repo_id, owner, name
        FROM ingestion.code_repositories
        WHERE id = ${gen.repository_id}::uuid
      `),
    ) as Array<{ provider_repo_id: string; owner: string; name: string }>;
    const snapRows = Array.from(
      await tx.execute(sql`
        SELECT commit_sha, tree_sha
        FROM ingestion.repository_snapshots
        WHERE id = ${gen.snapshot_id}::uuid
      `),
    ) as Array<{ commit_sha: string; tree_sha: string }>;
    const scopeRows = Array.from(
      await tx.execute(sql`
        SELECT scope_key, kind, display_name, domain_slug, file_count
        FROM ingestion.code_scopes
        WHERE generation_id = ${generationId}::uuid
      `),
    ) as Array<{
      scope_key: string;
      kind: string;
      display_name: string;
      domain_slug: string | null;
      file_count: number;
    }>;
    return { repo: repoRows[0]!, snap: snapRows[0]!, scopes: scopeRows };
  });

  // 3. Project into Neo4j BEFORE the flip (idempotent MERGE, keyed by snapshot).
  const scopes: ProjectSnapshotScope[] = proj.scopes.map((s) => ({
    scopeKey: s.scope_key,
    kind: s.kind,
    displayName: s.display_name,
    domainSlug: s.domain_slug,
    fileCount: Number(s.file_count),
  }));
  await projectSnapshotToGraph({
    repository: {
      providerRepoId: proj.repo.provider_repo_id,
      owner: proj.repo.owner,
      name: proj.repo.name,
    },
    snapshot: { commitSha: proj.snap.commit_sha, treeSha: proj.snap.tree_sha },
    scopes,
  });
  await pruneLegacySourceDetail({ owner: proj.repo.owner, repo: proj.repo.name });

  // 4. Atomic flip — the LAST operation. Serialize per repository via the
  //    code_repositories row lock, re-check the gate, supersede, activate,
  //    advance projected_head_sha.
  const activated = await withTenantDb(async (tx) => {
    await tx.execute(sql`
      SELECT id FROM ingestion.code_repositories
      WHERE id = ${gen.repository_id}::uuid
      FOR UPDATE
    `);

    const recheck = Array.from(
      await tx.execute(sql`
        SELECT status, files_total, files_processed, files_skipped
        FROM ingestion.projection_generations
        WHERE id = ${generationId}::uuid
      `),
    ) as Array<{
      status: string;
      files_total: number;
      files_processed: number;
      files_skipped: number;
    }>;
    const r = recheck[0];
    if (
      !r ||
      r.status !== "building" ||
      Number(r.files_processed) + Number(r.files_skipped) <
        Number(r.files_total)
    ) {
      return false;
    }

    // Supersede every OTHER active generation of this repository.
    await tx.execute(sql`
      UPDATE ingestion.projection_generations
      SET status = 'superseded', updated_at = NOW()
      WHERE repository_id = ${gen.repository_id}::uuid
        AND status = 'active'
        AND id <> ${generationId}::uuid
    `);
    // Activate this generation.
    await tx.execute(sql`
      UPDATE ingestion.projection_generations
      SET status = 'active', activated_at = NOW(), completed_at = NOW(), updated_at = NOW()
      WHERE id = ${generationId}::uuid
    `);
    // Advance the projected head to this snapshot's commit.
    await tx.execute(sql`
      UPDATE ingestion.code_repositories
      SET projected_head_sha = ${proj.snap.commit_sha}, updated_at = NOW()
      WHERE id = ${gen.repository_id}::uuid
    `);
    return true;
  });

  return {
    activated,
    generationId,
    repositoryId: gen.repository_id,
    commitSha: proj.snap.commit_sha,
  };
}
