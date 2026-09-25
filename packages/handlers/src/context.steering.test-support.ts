// In-memory doubles for the steering seams (ADR-061): a `SteeringStore`
// that keeps rows in arrays with the same invariants the Postgres store
// relies on (one open PR per lineage, idempotent appends by hash, a
// hash-chained ledger), and a `SteeringGitHub` that records what it was asked
// to do and serves the files it was given. The handler tests assert
// behaviour through these — what state a call leaves, what it refuses, what
// reaches GitHub — never the shape of a fixture.
import type { CapabilityContext } from "@oxagen/oxagen";
import type { SecurityEventInput } from "@oxagen/telemetry";
import { contextRecordLabel } from "@oxagen/oxagen/context-record-label";
import type { SteeringDeps } from "./context.steering.deps";
import type {
  SteeringGitHub,
  SteeringRepository,
} from "./context.steering.github";
import type { ProposalStatus } from "@oxagen/oxagen/contracts/context.steering.shared";
import {
  alreadyMerged,
  headMoved,
  proposalMoved,
  type AppendRow,
  type ProposalRow,
  type PublishedRecordRow,
  type SteeringStore,
} from "./context.steering.store";
import { canonicalJson, sha256Hex } from "./registry-digest";
import { readRecordFile } from "./context.steering.file";
import type { RegistryRecord, SyncPlan } from "./context.steering.sync.plan";
import {
  SYNC_POLICY_VERSION,
  type AppliedSync,
  type ApplyInput,
  type SyncState,
  type SyncStateWrite,
  type SyncStore,
} from "./context.steering.sync.store";

type SyncScope = { orgId: string; workspaceId: string };

export const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
export const AUTHOR = "0192d4a8-7c1e-7a00-8000-0000000005e1";
export const REVIEWER = "0192d4a8-7c1e-7a00-8000-0000000005e2";

export function ctx(over: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    orgId: SCOPE.orgId,
    workspaceId: SCOPE.workspaceId,
    userId: AUTHOR,
    apiKeyId: null,
    requestId: "req_1",
    surface: "api",
    messageId: null,
    ...over,
  };
}

let seq = 0;
const nextId = (prefix: string) => {
  seq += 1;
  return `${prefix}_${String(seq).padStart(22, "0")}`;
};
const uuid = () => crypto.randomUUID();

const OPEN = new Set([
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
]);

export class MemoryStore implements SteeringStore {
  proposals: ProposalRow[] = [];
  records: PublishedRecordRow[] = [];
  versions: {
    id: string;
    publicId: string;
    recordId: string;
    version: number;
    checksum: string;
    isLatest: boolean;
    publishedAt: Date | null;
    body: string;
    // The classification the body carries, as the Postgres store writes it
    // on the version row (#3312).
    kind: string | null;
    force: string | null;
    constraintEffect: string | null;
    statement: string | null;
  }[] = [];
  ledger: {
    id: string;
    publicId: string;
    recordId: string;
    seq: number;
    chainDigest: string;
    prev: string | null;
    policyVersion: string;
    approverUserId: string | null;
    /** `promote` when absent; the repository sync also writes `retire`. */
    action?: "promote" | "retire";
  }[] = [];
  appends: AppendRow[] = [];

  async insertProposal(
    values: Parameters<SteeringStore["insertProposal"]>[0],
    options?: Parameters<SteeringStore["insertProposal"]>[1],
  ) {
    // The Postgres store takes the lineage's advisory lock and refuses a slug
    // a record or a proposal already holds (ADR-178). The refusal is what a
    // caller branches on, so the double reproduces it over its own rows; the
    // lock has no meaning here. context.steering.store.pg.test.ts proves the
    // real one against a database.
    if (options?.createOnly) {
      // Both columns are citext, so the store matches ignoring case.
      const lineage = values.lineageId.toLowerCase();
      const held =
        this.records.some(
          (r) =>
            r.orgId === values.orgId &&
            r.workspaceId === values.workspaceId &&
            r.slug.toLowerCase() === lineage,
        ) ||
        this.proposals.some(
          (p) =>
            p.orgId === values.orgId &&
            p.workspaceId === values.workspaceId &&
            p.lineageId.toLowerCase() === lineage,
        );
      if (held) {
        const { HandlerError } = await import("@oxagen/oxagen");
        throw new HandlerError({
          code: "conflict",
          reason: "clone_name_taken",
          message:
            "This slug already belongs to a record or a proposal. Choose another slug.",
        });
      }
    }
    const now = new Date();
    const row: ProposalRow = {
      id: uuid(),
      publicId: nextId("prp"),
      createdAt: now,
      updatedAt: now,
      updatedById: null,
      status: "proposed",
      governanceMode: null,
      provider: null,
      repository: null,
      baseRef: null,
      branch: null,
      path: null,
      prNumber: null,
      prUrl: null,
      headSha: null,
      stampedRecordId: null,
      recordHash: null,
      checks: [],
      mergedCommit: null,
      mergedAt: null,
      mergedByUserId: null,
      publishedRecordId: null,
      promotionEventId: null,
      dismissedAt: null,
      dismissedReason: null,
      ...values,
    };
    this.proposals.push(row);
    return row;
  }
  async findProposal(scope: { workspaceId: string }, publicId: string) {
    return (
      this.proposals.find(
        (p) => p.workspaceId === scope.workspaceId && p.publicId === publicId,
      ) ?? null
    );
  }
  async findProposalById(id: string) {
    return this.proposals.find((p) => p.id === id) ?? null;
  }
  async mergedRefs(row: ProposalRow) {
    const promotion = this.ledger.find((l) => l.id === row.promotionEventId);
    const record = this.records.find((r) => r.id === row.publishedRecordId);
    return promotion && record
      ? {
          promotionEventPublicId: promotion.publicId,
          recordPublicId: record.publicId,
        }
      : null;
  }
  async findOpenPrOnLineage(
    scope: { workspaceId: string },
    lineageId: string,
    excludingId: string,
  ) {
    return (
      this.proposals.find(
        (p) =>
          p.workspaceId === scope.workspaceId &&
          p.lineageId === lineageId &&
          OPEN.has(p.status) &&
          p.id !== excludingId,
      ) ?? null
    );
  }
  async listProposals(
    scope: { workspaceId: string },
    filter: { status?: string; lineageId?: string },
    page: { limit: number; offset: number },
  ) {
    const rows = this.proposals
      .filter((p) => p.workspaceId === scope.workspaceId)
      .filter((p) => !filter.status || p.status === filter.status)
      .filter((p) => !filter.lineageId || p.lineageId === filter.lineageId)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (b.publicId < a.publicId ? -1 : 1),
      );
    return {
      rows: rows.slice(page.offset, page.offset + page.limit),
      total: rows.length,
    };
  }
  async updateProposal(
    id: string,
    patch: Parameters<SteeringStore["updateProposal"]>[1],
    from: readonly ProposalStatus[],
    guard?: { headSha: string },
  ) {
    const i = this.proposals.findIndex((p) => p.id === id);
    if (i < 0) throw new Error(`no proposal ${id}`);
    const current = this.proposals[i]!;
    if (!from.includes(current.status as ProposalStatus))
      throw proposalMoved(current.publicId, current.status);
    if (guard && current.headSha !== guard.headSha)
      throw headMoved(current.publicId, current.headSha, guard.headSha);
    const next = { ...this.proposals[i]!, ...patch, updatedAt: new Date() };
    if (
      OPEN.has(next.status) &&
      this.proposals.some(
        (p) =>
          p.id !== id &&
          p.workspaceId === next.workspaceId &&
          p.lineageId === next.lineageId &&
          OPEN.has(p.status),
      )
    ) {
      throw new Error("context_proposals_open_pr_idx: one open PR per lineage");
    }
    this.proposals[i] = next;
    return next;
  }
  async listRecords(
    scope: { workspaceId: string },
    filter: {
      kind?: string;
      sharingScope?: string;
      status?: string;
      lineageId?: string;
    },
    page: { limit: number; offset: number },
  ) {
    const rows = this.records
      .filter(
        (r) => r.workspaceId === scope.workspaceId && r.deletedAt === null,
      )
      .filter((r) => !filter.kind || r.kind === filter.kind)
      .filter(
        (r) => !filter.sharingScope || r.sharingScope === filter.sharingScope,
      )
      .filter((r) => !filter.status || r.status === filter.status)
      .filter((r) => !filter.lineageId || r.slug === filter.lineageId);
    return {
      rows: rows.slice(page.offset, page.offset + page.limit),
      total: rows.length,
    };
  }
  async findRecord(scope: { workspaceId: string }, idOrLineage: string) {
    const record = this.records.find(
      (r) =>
        r.workspaceId === scope.workspaceId &&
        (r.publicId === idOrLineage || r.slug === idOrLineage),
    );
    if (!record) return null;
    const versions = this.versions
      .filter((v) => v.recordId === record.id)
      .sort((a, b) => b.version - a.version);
    const publisher = this.proposals.find(
      (p) => p.publishedRecordId === record.id && p.status === "merged",
    );
    return {
      record,
      versions,
      publishedBy: publisher
        ? { proposalPublicId: publisher.publicId, prUrl: publisher.prUrl }
        : null,
    };
  }
  /** The same rollup the Postgres store runs: distinct runs, per kind, per lineage. */
  async recordEffect(scope: { workspaceId: string }, lineageId: string) {
    const mine = this.appends.filter(
      (a) =>
        a.workspaceId === scope.workspaceId &&
        (a.kind === "context_use" || a.kind === "context_use_feedback"),
    );
    if (mine.length === 0) return null;
    const runs = (kind: string) => {
      const seen = new Set<string>();
      for (const a of mine) {
        if (a.kind !== kind || a.lineageId !== lineageId) continue;
        for (const ref of a.sourceRefs ?? []) {
          const run = /^frame:([^/]+)\//.exec(ref)?.[1];
          if (run) seen.add(run);
        }
      }
      return seen.size;
    };
    return {
      rendered: runs("context_use"),
      cited: runs("context_use_feedback"),
    };
  }
  async listActiveRecords(scope: { workspaceId: string }) {
    return this.records.filter(
      (r) =>
        r.workspaceId === scope.workspaceId &&
        r.status === "active" &&
        r.deletedAt === null,
    );
  }
  async ledgerLength(scope: { workspaceId: string }) {
    return this.ledger.filter(
      (l) =>
        this.records.find((r) => r.id === l.recordId)?.workspaceId ===
        scope.workspaceId,
    ).length;
  }
  /** The newest record in this workspace that a Context PR actually merged. */
  async latestPublication(scope: { workspaceId: string }) {
    // Newest publication wins. Publications that share an instant (GitHub
    // reports `merged_at` to the second) are all returned: the store cannot
    // say which landed later on the branch, and the real one does not either.
    const published = this.records.filter(
      (r) =>
        r.workspaceId === scope.workspaceId &&
        r.deletedAt === null &&
        r.commitSha !== null &&
        r.publishedAt !== null,
    );
    if (published.length === 0) return null;
    const newestInstant = Math.max(
      ...published.map((r) => (r.publishedAt as Date).getTime()),
    );
    // Last written first, the order `id desc` gives the real store.
    const tied = published
      .filter((r) => (r.publishedAt as Date).getTime() === newestInstant)
      .reverse();
    return {
      commitSha: tied[0]!.commitSha as string,
      commitShas: [...new Set(tied.map((r) => r.commitSha as string))],
      publishedAt: tied[0]!.publishedAt as Date,
    };
  }
  /** The in-memory store has no concurrency to race, so this is the same two reads. */
  async versionAndPublication(scope: { workspaceId: string }) {
    const [version, publication] = await Promise.all([
      this.ledgerLength(scope),
      this.latestPublication(scope),
    ]);
    return { version, publication };
  }
  async insertAppend(values: Parameters<SteeringStore["insertAppend"]>[0]) {
    const existing = this.appends.find(
      (a) =>
        a.workspaceId === values.workspaceId &&
        a.recordHash === values.recordHash,
    );
    if (existing) return { row: existing, appended: false };
    const row: AppendRow = {
      id: uuid(),
      publicId: nextId("cta"),
      createdAt: new Date(),
      ...values,
    };
    this.appends.push(row);
    return { row, appended: true };
  }
  async findAppend(scope: { workspaceId: string }, publicId: string) {
    return (
      this.appends.find(
        (a) => a.workspaceId === scope.workspaceId && a.publicId === publicId,
      ) ?? null
    );
  }
  async findAppendByHash(scope: { workspaceId: string }, recordHash: string) {
    return (
      this.appends.find(
        (a) =>
          a.workspaceId === scope.workspaceId && a.recordHash === recordHash,
      ) ?? null
    );
  }
  async publishMerge(input: Parameters<SteeringStore["publishMerge"]>[0]) {
    const { scope, proposal } = input;
    const existing = this.records.find(
      (r) =>
        r.workspaceId === scope.workspaceId && r.slug === proposal.lineageId,
    );
    const classification = {
      title: proposal.title?.trim() || proposal.statement,
      label:
        readRecordFile(input.body)?.label ??
        proposal.label ??
        existing?.label ??
        contextRecordLabel(proposal.lineageId),
      status: "active",
      kind: proposal.kind,
      force: proposal.force,
      constraintEffect: proposal.constraintEffect,
      sharingScope: proposal.sharingScope,
      statement: proposal.statement,
      commitSha: input.commitSha,
      path: input.path,
      publishedAt: input.mergedAt,
      activatedByUserId: input.mergedByUserId,
      activatedAt: input.mergedAt,
      updatedAt: input.mergedAt,
    };
    const record: PublishedRecordRow = existing ?? {
      id: uuid(),
      publicId: nextId("ctr"),
      createdAt: input.mergedAt,
      createdById: input.mergedByUserId,
      updatedById: input.mergedByUserId,
      deletedAt: null,
      deletedById: null,
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      slug: proposal.lineageId,
      activeVersionId: null,
      validUntil: null,
      version: null,
      checksum: null,
      ...classification,
    };
    const latest = this.versions
      .filter((v) => v.recordId === record.id)
      .sort((a, b) => b.version - a.version)[0];
    const version = {
      id: uuid(),
      publicId: nextId("crv"),
      recordId: record.id,
      version: (latest?.version ?? 0) + 1,
      checksum: input.checksum,
      isLatest: true,
      publishedAt: input.mergedAt,
      body: input.body,
      kind: proposal.kind,
      force: proposal.force,
      constraintEffect: proposal.constraintEffect,
      statement: proposal.statement,
    };
    const ledgerBefore = await this.ledgerLength(scope);
    const head = this.ledger
      .filter((l) => l.recordId === record.id)
      .sort((a, b) => b.seq - a.seq)[0];
    const seqNo = (head?.seq ?? 0) + 1;
    const prev = head?.chainDigest ?? null;
    const chainDigest = sha256Hex(
      (prev ?? "") +
        canonicalJson({
          action: "promote",
          approver_user_id: input.mergedByUserId,
          policy_version: input.policyVersion,
          record_id: record.id,
          seq: seqNo,
          version_id: version.id,
        }),
    );
    const promotion = {
      id: uuid(),
      publicId: nextId("ctp"),
      recordId: record.id,
      seq: seqNo,
      chainDigest,
      prev,
      policyVersion: input.policyVersion,
      approverUserId: input.mergedByUserId,
    };
    // The Postgres store's transaction commits only when the proposal is
    // still at `checks_passed`; nothing above is written before this point.
    if (
      this.proposals.find((p) => p.id === proposal.id)?.status !==
      "checks_passed"
    )
      throw alreadyMerged(proposal.publicId);
    if (!existing) this.records.push(record);
    if (latest) latest.isLatest = false;
    this.versions.push(version);
    Object.assign(record, classification, {
      activeVersionId: version.id,
      version: version.version,
      checksum: version.checksum,
    });
    this.ledger.push(promotion);
    await this.updateProposal(proposal.id, { status: "merged" }, [
      "checks_passed",
    ]);
    Object.assign(this.proposals.find((p) => p.id === proposal.id)!, {
      mergedCommit: input.commitSha,
      mergedAt: input.mergedAt,
      mergedByUserId: input.mergedByUserId,
      publishedRecordId: record.id,
      promotionEventId: promotion.id,
    });
    return {
      recordId: record.id,
      recordPublicId: record.publicId,
      versionId: version.id,
      version: version.version,
      promotion: {
        id: promotion.id,
        publicId: promotion.publicId,
        seq: seqNo,
        chainDigest,
      },
      ledgerBefore,
    };
  }
}

const pullUrl = (n: number) => `https://github.com/a-intel/platform/pull/${n}`;

export const REPO: SteeringRepository = {
  provider: "github",
  owner: "a-intel",
  repo: "platform",
  fullName: "a-intel/platform",
  // The un-renamed case, which is every test that does not care: the approved
  // name and the current one agree. A test about a rename sets them apart
  // itself rather than this fixture carrying a divergence nothing asked for.
  currentFullName: "a-intel/platform",
  defaultBranch: "main",
};

/**
 * A GitHub with commits: every branch head is a sha with a parent, a file is
 * read at a sha or at a branch (its head), a PR's changed paths are the diff
 * from its merge base, a merge is pinned to the head it was asked for, a
 * second PR on a head and base is refused, and a branch stays until it is
 * deleted.
 */
export class FakeGitHub implements SteeringGitHub {
  /** `${sha}:${path}` → content. */
  files = new Map<string, string>();
  /** branch → head sha. */
  heads = new Map<string, string>();
  /** sha → its parent sha. */
  private parents = new Map<string, string>();
  /**
   * sha → when it was committed and what its message said. A commit's date and
   * message are fixed when it is made, which is what lets a test read a
   * record's provenance back off the commit that published it rather than off
   * the clock at read time.
   */
  private commitMeta = new Map<string, { at: Date; message: string }>();
  branches: { branch: string; from: string }[] = [];
  commits: { path: string; branch: string; message: string }[] = [];
  pulls: {
    number: number;
    title: string;
    head: string;
    base: string;
    body: string;
    labels: readonly string[];
    state: "open" | "closed";
    merged: boolean;
    mergeCommitSha: string | null;
    mergedAt: Date | null;
    /** The head sha at close or merge; the branch may be gone after. */
    headSha: string;
  }[] = [];
  checkRuns: {
    name: string;
    headSha: string;
    conclusion: string;
    summary: string;
  }[] = [];
  merges: { number: number; commitTitle: string; sha: string }[] = [];
  deletedBranches: string[] = [];
  /** Set to make check-run creation answer like a non-App token (403). */
  checksRefused = false;
  /** Set to make the merge refused by GitHub (a required review). */
  mergeRefusedWith: string | null = null;
  repository: SteeringRepository | null = REPO;
  /** What GitHub stamps `merged_at` with; the harness shares its clock. */
  clock: () => Date = () => new Date();
  private prNumber = 518;
  private commitNo = 0;

  constructor(files: Record<string, string> = {}) {
    this.heads.set(REPO.defaultBranch, "base0");
    for (const [k, v] of Object.entries(files)) {
      const [ref, path] = [
        k.slice(0, k.indexOf(":")),
        k.slice(k.indexOf(":") + 1),
      ];
      this.files.set(`${this.heads.get(ref) ?? ref}:${path}`, v);
    }
  }
  private refused(message: string): Promise<never> {
    return import("@oxagen/oxagen").then(({ HandlerError }) => {
      throw new HandlerError({
        code: "conflict",
        reason: "github_refused",
        message,
      });
    });
  }
  private shaOf(ref: string): string {
    return this.heads.get(ref) ?? ref;
  }
  private nextSha(): string {
    this.commitNo += 1;
    return `head${this.commitNo}`;
  }
  /** A commit on a branch, as anyone with push access makes one. */
  commit(branch: string, path: string, content: string, message = ""): string {
    const parent = this.shaOf(branch);
    const sha = this.nextSha();
    for (const [key, c] of this.files)
      if (key.startsWith(`${parent}:`))
        this.files.set(`${sha}:${key.slice(parent.length + 1)}`, c);
    this.files.set(`${sha}:${path}`, content);
    this.parents.set(sha, parent);
    this.commitMeta.set(sha, {
      at: this.clock(),
      message: message || `commit ${sha}`,
    });
    this.heads.set(branch, sha);
    return sha;
  }
  private lineage(sha: string): string[] {
    const out = [sha];
    for (let p = this.parents.get(sha); p; p = this.parents.get(p)) out.push(p);
    return out;
  }
  private tree(sha: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [key, c] of this.files)
      if (key.startsWith(`${sha}:`)) out.set(key.slice(sha.length + 1), c);
    return out;
  }
  async resolveRepository() {
    if (!this.repository) {
      const { HandlerError } = await import("@oxagen/oxagen");
      throw new HandlerError({
        code: "not_found",
        reason: "workspace_repository_missing",
      });
    }
    return this.repository;
  }
  async readFile(_repo: SteeringRepository, path: string, ref: string) {
    return this.files.get(`${this.shaOf(ref)}:${path}`) ?? null;
  }
  /**
   * The newest commit on `ref` whose tree holds `path`, walking the parent
   * chain the way git does. Null when nothing on that ref ever wrote it, so a
   * test can put a file in the constructor's seed — which has no commit behind
   * it — and see the provenance block report exactly that.
   */
  async lastCommitForPath(
    _repo: SteeringRepository,
    path: string,
    ref: string,
  ) {
    // A directory's content is every file under it, so the same walk answers
    // the commit that last changed anything in `.oxagen/rules/`.
    const snapshot = (sha: string): string | undefined => {
      const exact = this.files.get(`${sha}:${path}`);
      if (exact !== undefined) return exact;
      const under = [...this.tree(sha)]
        .filter(([p]) => p.startsWith(`${path}/`))
        .sort(([a], [b]) => a.localeCompare(b));
      return under.length > 0 ? JSON.stringify(under) : undefined;
    };
    for (const sha of this.lineage(this.shaOf(ref))) {
      // GitHub lists the commits that CHANGED the path, not the ones whose
      // tree happens to hold it. Every commit after a file lands carries that
      // file forward, so a fake that ignored the parent would hand a record
      // the provenance of whatever landed on the branch last.
      // A commit that removed the path changed it too, as GitHub counts it.
      const content = snapshot(sha);
      const parent = this.parents.get(sha);
      const before = parent ? snapshot(parent) : undefined;
      if (content === undefined && before === undefined) continue;
      if (parent && before === content) continue;
      const meta = this.commitMeta.get(sha);
      // No recorded commit means the file came from the constructor's seed,
      // which has no commit behind it. Null, so a test can see the provenance
      // block report exactly that instead of a date the fake invented.
      if (!meta) return null;
      return {
        sha,
        authorName: "Fixture Author",
        authorLogin: "fixture-author",
        committedAt: meta.at.toISOString(),
        summary: meta.message.split("\n", 1)[0] ?? "",
      };
    }
    return null;
  }
  async ensureBranch(
    _repo: SteeringRepository,
    branch: string,
    from: string,
    options?: { exclusive: boolean },
  ) {
    if (this.heads.has(branch)) {
      if (options?.exclusive) {
        const { HandlerError } = await import("@oxagen/oxagen");
        throw new HandlerError({
          code: "conflict",
          reason: "proposal_branch_exists",
        });
      }
      return;
    }
    this.branches.push({ branch, from });
    this.heads.set(branch, this.shaOf(from));
  }
  async reconcileFiles(
    _repo: SteeringRepository,
    args: { branch: string; roots: string[]; files: string[] },
  ) {
    for (const path of this.tree(this.shaOf(args.branch)).keys()) {
      if (
        args.roots.some(
          (root) => path === root || path.startsWith(`${root}/`),
        ) &&
        !args.files.includes(path)
      ) {
        const sha = this.commit(args.branch, path, "");
        this.files.delete(`${sha}:${path}`);
      }
    }
  }
  async putFile(
    _repo: SteeringRepository,
    args: { path: string; content: string; message: string; branch: string },
  ) {
    const commitSha = this.commit(
      args.branch,
      args.path,
      args.content,
      args.message,
    );
    this.commits.push({
      path: args.path,
      branch: args.branch,
      message: args.message,
    });
    return { commitSha };
  }
  async openPullRequest(
    _repo: SteeringRepository,
    args: {
      title: string;
      head: string;
      base: string;
      body: string;
      labels?: readonly string[];
    },
  ) {
    const open = this.pulls.find(
      (p) => p.head === args.head && p.base === args.base && p.state === "open",
    );
    if (open) {
      return this.refused(
        `GitHub API error 422: A pull request already exists for ${args.head}.`,
      );
    }
    this.prNumber += 1;
    const { labels = [], ...rest } = args;
    this.pulls.push({
      number: this.prNumber,
      ...rest,
      labels,
      state: "open",
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      headSha: this.shaOf(args.head),
    });
    return { number: this.prNumber, htmlUrl: pullUrl(this.prNumber) };
  }
  async updatePullRequest(
    _repo: SteeringRepository,
    args: { number: number; title: string; body: string },
  ) {
    const pr = this.pulls.find((p) => p.number === args.number);
    if (!pr) return this.refused("Pull request not found");
    pr.title = args.title;
    pr.body = args.body;
    return { number: pr.number, htmlUrl: pullUrl(pr.number) };
  }
  async findOpenPullRequest(
    _repo: SteeringRepository,
    args: { head: string; base: string },
  ) {
    const pr = this.pulls.find(
      (p) => p.head === args.head && p.base === args.base && p.state === "open",
    );
    return pr
      ? { number: pr.number, htmlUrl: pullUrl(pr.number), body: pr.body }
      : null;
  }
  async changedPaths(_repo: SteeringRepository, base: string, head: string) {
    const onBase = new Set(this.lineage(this.shaOf(base)));
    const mergeBase = this.lineage(this.shaOf(head)).find((s) => onBase.has(s));
    const from = mergeBase ? this.tree(mergeBase) : new Map<string, string>();
    const to = this.tree(this.shaOf(head));
    return [...new Set([...from.keys(), ...to.keys()])]
      .filter((path) => from.get(path) !== to.get(path))
      .sort();
  }
  private pull(number: number) {
    const pr = this.pulls.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR #${number}`);
    return pr;
  }
  async getPullRequest(_repo: SteeringRepository, number: number) {
    const pr = this.pull(number);
    return {
      baseRef: pr.base,
      headSha: pr.state === "open" ? this.shaOf(pr.head) : pr.headSha,
      open: pr.state === "open",
      merged: pr.merged,
      mergeCommitSha: pr.mergeCommitSha,
      mergedAt: pr.mergedAt,
    };
  }
  async branchHead(_repo: SteeringRepository, branch: string) {
    return this.heads.get(branch) ?? null;
  }
  async listFiles(_repo: SteeringRepository, ref: string, dir: string) {
    return [...this.tree(this.shaOf(ref)).keys()]
      .filter((path) => path.startsWith(`${dir}/`))
      .sort();
  }
  /** Remove a file on a branch, as a person with push access does. */
  remove(branch: string, path: string, message = ""): string {
    const sha = this.commit(branch, path, "", message);
    this.files.delete(`${sha}:${path}`);
    return sha;
  }
  /** Rename a file on a branch in one commit, as `git mv` does. */
  rename(branch: string, from: string, to: string, message = ""): string {
    const content = this.files.get(`${this.shaOf(branch)}:${from}`);
    if (content === undefined) throw new Error(`no ${from} on ${branch}`);
    const sha = this.commit(branch, to, content, message);
    this.files.delete(`${sha}:${from}`);
    return sha;
  }
  /** Merge an open PR on the host, as a person clicking Merge on GitHub does. */
  mergeOnHost(number: number): string {
    const pr = this.pull(number);
    const head = this.shaOf(pr.head);
    const base = this.shaOf(pr.base);
    const mergeSha = `hostmerge${number}`;
    for (const [key, content] of this.files)
      if (key.startsWith(`${head}:`))
        this.files.set(`${mergeSha}:${key.slice(head.length + 1)}`, content);
    this.parents.set(mergeSha, base);
    const mergedAt = this.clock();
    this.commitMeta.set(mergeSha, {
      at: mergedAt,
      message: `Merge #${number}`,
    });
    this.heads.set(pr.base, mergeSha);
    Object.assign(pr, {
      state: "closed",
      merged: true,
      mergeCommitSha: mergeSha,
      mergedAt,
      headSha: head,
    });
    return mergeSha;
  }
  /** Close an open PR on the host without merging it. */
  closeOnHost(number: number): void {
    const pr = this.pull(number);
    Object.assign(pr, { state: "closed", headSha: this.shaOf(pr.head) });
  }
  async reportCheckRun(
    _repo: SteeringRepository,
    args: {
      name: string;
      headSha: string;
      conclusion: "success" | "failure";
      summary: string;
    },
  ) {
    if (this.checksRefused) return null;
    this.checkRuns.push({
      name: args.name,
      headSha: args.headSha,
      conclusion: args.conclusion,
      summary: args.summary,
    });
    return `https://github.com/a-intel/platform/runs/${this.checkRuns.length}`;
  }
  async mergePullRequest(
    _repo: SteeringRepository,
    args: { number: number; commitTitle: string; sha: string },
  ) {
    if (this.mergeRefusedWith) return this.refused(this.mergeRefusedWith);
    const pr = this.pull(args.number);
    if (pr.state !== "open") {
      return this.refused(
        "GitHub API error 405: Pull Request is not mergeable",
      );
    }
    const head = this.shaOf(pr.head);
    if (head !== args.sha) {
      return this.refused("GitHub API error 409: Head branch was modified");
    }
    this.merges.push(args);
    const mergeSha = `merge${args.number}`;
    for (const [key, content] of this.files)
      if (key.startsWith(`${head}:`))
        this.files.set(`${mergeSha}:${key.slice(head.length + 1)}`, content);
    this.parents.set(mergeSha, this.shaOf(pr.base));
    const mergedAt = this.clock();
    // The merge commit is the publishing commit: it is what put these bytes on
    // the production branch, so it is what a record's provenance names.
    this.commitMeta.set(mergeSha, { at: mergedAt, message: args.commitTitle });
    this.heads.set(pr.base, mergeSha);
    Object.assign(pr, {
      state: "closed",
      merged: true,
      mergeCommitSha: mergeSha,
      mergedAt,
      headSha: head,
    });
    return { sha: mergeSha };
  }
  async closePullRequest(_repo: SteeringRepository, number: number) {
    const pr = this.pull(number);
    if (pr.state !== "open") return;
    Object.assign(pr, { state: "closed", headSha: this.shaOf(pr.head) });
  }
  async deleteBranch(_repo: SteeringRepository, branch: string) {
    if (this.heads.delete(branch)) this.deletedBranches.push(branch);
  }
}

export interface Harness extends SteeringDeps {
  store: MemoryStore;
  github: FakeGitHub;
  events: SecurityEventInput[];
  roleOf: Map<string, { org: string | null; workspace: string | null }>;
}

export function harness(files: Record<string, string> = {}): Harness {
  const roleOf = new Map<
    string,
    { org: string | null; workspace: string | null }
  >();
  roleOf.set(AUTHOR, { org: null, workspace: "Member" });
  roleOf.set(REVIEWER, { org: "Admin", workspace: null });
  const events: SecurityEventInput[] = [];
  let tick = Date.parse("2026-09-15T09:16:40.000Z");
  const github = new FakeGitHub(files);
  // One clock for GitHub and the platform, so a test can tell a merge's
  // time apart from the time of the call that published it.
  github.clock = () => new Date((tick += 1000));
  return {
    store: new MemoryStore(),
    github,
    roles: {
      orgRole: async (_org, userId) => roleOf.get(userId)?.org ?? null,
      workspaceRole: async (_org, _ws, userId) =>
        roleOf.get(userId)?.workspace ?? null,
    },
    now: () => new Date((tick += 1000)),
    emit: (e) => {
      events.push(e);
    },
    events,
    roleOf,
  };
}

/**
 * The repository sync's store (ADR-182) over a `MemoryStore`'s own arrays, so
 * a test can run `merge_context_pr` and the sync against one registry and see
 * whether they agree. `apply` writes versions and ledger links the way the
 * Postgres store does: one version per publication, the chain digest over the
 * same canonical fields, and a `retire` link with no version.
 */
export class MemorySyncStore implements SyncStore {
  state: SyncState | null = null;
  applied = 0;
  constructor(private readonly store: MemoryStore) {}

  async readState() {
    return this.state;
  }
  async markRequested(_scope: SyncScope, at: Date) {
    this.state = {
      ...(this.state ?? {
        provider: null,
        repository: null,
        branch: null,
        headSha: null,
        status: "pending" as const,
        findings: [],
        error: null,
        syncedAt: null,
      }),
      requestedAt: at,
    };
  }
  async writeState(_scope: SyncScope, state: SyncStateWrite) {
    this.state = { ...state, requestedAt: this.state?.requestedAt ?? null };
  }

  private chain(
    recordId: string,
    versionId: string | null,
    action: "promote" | "retire",
  ) {
    const head = this.store.ledger
      .filter((l) => l.recordId === recordId)
      .sort((a, b) => b.seq - a.seq)[0];
    const seq = (head?.seq ?? 0) + 1;
    const prev = head?.chainDigest ?? null;
    const chainDigest = sha256Hex(
      (prev ?? "") +
        canonicalJson({
          action,
          approver_user_id: null,
          policy_version: SYNC_POLICY_VERSION,
          record_id: recordId,
          seq,
          version_id: versionId,
        }),
    );
    this.store.ledger.push({
      id: uuid(),
      publicId: nextId("ctp"),
      recordId,
      seq,
      chainDigest,
      prev,
      policyVersion: SYNC_POLICY_VERSION,
      approverUserId: null,
      action,
    });
  }

  async apply(
    scope: SyncScope,
    input: ApplyInput,
    planFor: (records: RegistryRecord[]) => SyncPlan,
  ): Promise<AppliedSync> {
    this.applied += 1;
    const mine = this.store.records.filter(
      (r) => r.workspaceId === scope.workspaceId,
    );
    const plan = planFor(
      mine.map((r) => ({
        id: r.id,
        slug: r.slug,
        path: r.path,
        status: r.status,
        deleted: r.deletedAt !== null,
        label: r.label ?? null,
        kind: r.kind,
        constraintEffect: r.constraintEffect,
        statement: r.statement,
        body:
          this.store.versions.find((v) => v.id === r.activeVersionId)?.body ??
          null,
      })),
    );
    let created = 0;
    let revised = 0;
    for (const p of plan.publish) {
      let record = p.recordId
        ? this.store.records.find((r) => r.id === p.recordId)
        : undefined;
      if (!record) {
        record = {
          id: uuid(),
          publicId: nextId("ctr"),
          createdAt: input.now,
          createdById: null,
          updatedById: null,
          deletedAt: null,
          deletedById: null,
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          slug: p.lineageId,
          title: p.content.statement,
          label: p.content.label ?? contextRecordLabel(p.lineageId),
          status: "active",
          kind: p.content.kind,
          force: p.content.force,
          constraintEffect: p.content.constraintEffect,
          sharingScope: p.content.sharingScope,
          statement: p.content.statement,
          commitSha: input.commitSha,
          path: p.path,
          publishedAt: input.publishedAt,
          activatedByUserId: null,
          activatedAt: input.publishedAt,
          updatedAt: input.now,
          activeVersionId: null,
          validUntil: null,
          version: null,
          checksum: null,
        };
        this.store.records.push(record);
        created += 1;
      } else revised += 1;
      const target = record;
      const latest = this.store.versions
        .filter((v) => v.recordId === target.id)
        .sort((a, b) => b.version - a.version)[0];
      if (latest) latest.isLatest = false;
      const version = {
        id: uuid(),
        publicId: nextId("crv"),
        recordId: target.id,
        version: (latest?.version ?? 0) + 1,
        checksum: p.checksum,
        isLatest: true,
        publishedAt: input.publishedAt,
        body: p.body,
        kind: p.content.kind,
        force: p.content.force,
        constraintEffect: p.content.constraintEffect,
        statement: p.content.statement,
      };
      this.store.versions.push(version);
      Object.assign(target, {
        slug: p.lineageId,
        label: p.content.label ?? target.label,
        status: "active",
        kind: p.content.kind,
        force: p.content.force,
        constraintEffect: p.content.constraintEffect,
        sharingScope: p.content.sharingScope,
        statement: p.content.statement,
        commitSha: input.commitSha,
        path: p.path,
        publishedAt: input.publishedAt,
        deletedAt: null,
        activeVersionId: version.id,
        version: version.version,
        checksum: version.checksum,
      });
      this.chain(target.id, version.id, "promote");
    }
    for (const u of plan.update) {
      const record = this.store.records.find((r) => r.id === u.recordId);
      if (!record) continue;
      if (u.slug !== undefined) record.slug = u.slug;
      if (u.path !== undefined) record.path = u.path;
      if (u.label !== undefined) record.label = u.label;
    }
    for (const r of plan.retire) {
      const record = this.store.records.find((x) => x.id === r.recordId);
      if (!record) continue;
      Object.assign(record, {
        status: "retired",
        commitSha: input.commitSha,
        publishedAt: input.publishedAt,
      });
      this.chain(record.id, null, "retire");
    }
    return {
      plan,
      created,
      revised,
      updated: plan.update.length,
      retired: plan.retire.length,
    };
  }

  async openProposals(scope: SyncScope) {
    return this.store.proposals.filter(
      (p) => p.workspaceId === scope.workspaceId && OPEN.has(p.status),
    );
  }

  async linkMergedProposal(
    scope: SyncScope,
    proposalId: string,
    args: { lineageId: string; mergedCommit: string; mergedAt: Date },
  ) {
    const record = this.store.records.find(
      (r) =>
        r.workspaceId === scope.workspaceId &&
        r.slug === args.lineageId &&
        r.status === "active" &&
        r.deletedAt === null,
    );
    if (!record) return false;
    const promotion = this.store.ledger
      .filter((l) => l.recordId === record.id && l.action !== "retire")
      .sort((a, b) => b.seq - a.seq)[0];
    if (!promotion) return false;
    const proposal = this.store.proposals.find((p) => p.id === proposalId);
    if (!proposal || !OPEN.has(proposal.status)) return false;
    Object.assign(proposal, {
      status: "merged",
      mergedCommit: args.mergedCommit,
      mergedAt: args.mergedAt,
      mergedByUserId: null,
      publishedRecordId: record.id,
      promotionEventId: promotion.id,
    });
    return true;
  }
}
