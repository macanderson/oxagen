// In-memory doubles for the steering seams (ADR-061): a `SteeringStore`
// that keeps rows in arrays with the same invariants the Postgres store
// relies on (one open PR per lineage, idempotent appends by hash, a
// hash-chained ledger), and a `SteeringGitHub` that records what it was asked
// to do and serves the files it was given. The handler tests assert
// behaviour through these — what state a call leaves, what it refuses, what
// reaches GitHub — never the shape of a fixture.
import type { CapabilityContext } from "@oxagen/oxagen";
import type { SecurityEventInput } from "@oxagen/telemetry";
import type { SteeringDeps } from "./context.steering.deps";
import type {
  SteeringGitHub,
  SteeringRepository,
} from "./context.steering.github";
import type {
  AppendRow,
  ProposalRow,
  PublishedRecordRow,
  SteeringStore,
} from "./context.steering.store";
import { canonicalJson, sha256Hex } from "./registry-digest";

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
  }[] = [];
  appends: AppendRow[] = [];

  async insertProposal(values: Parameters<SteeringStore["insertProposal"]>[0]) {
    const now = new Date();
    const row: ProposalRow = {
      id: uuid(),
      publicId: nextId("prp"),
      createdAt: now,
      updatedAt: now,
      updatedByUserId: null,
      status: "proposed",
      governanceMode: null,
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
  ) {
    const i = this.proposals.findIndex((p) => p.id === id);
    if (i < 0) throw new Error(`no proposal ${id}`);
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
    let record = this.records.find(
      (r) =>
        r.workspaceId === scope.workspaceId && r.slug === proposal.lineageId,
    );
    const classification = {
      title: proposal.statement,
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
    if (!record) {
      record = {
        id: uuid(),
        publicId: nextId("ctr"),
        createdAt: input.mergedAt,
        createdByUserId: input.mergedByUserId,
        updatedByUserId: input.mergedByUserId,
        deletedAt: null,
        deletedByUserId: null,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        slug: proposal.lineageId,
        activeVersionId: null,
        version: null,
        checksum: null,
        ...classification,
      };
      this.records.push(record);
    }
    const latest = this.versions
      .filter((v) => v.recordId === record!.id)
      .sort((a, b) => b.version - a.version)[0];
    if (latest) latest.isLatest = false;
    const version = {
      id: uuid(),
      publicId: nextId("crv"),
      recordId: record.id,
      version: (latest?.version ?? 0) + 1,
      checksum: input.checksum,
      isLatest: true,
      publishedAt: input.mergedAt,
      body: input.body,
    };
    this.versions.push(version);
    Object.assign(record, classification, {
      activeVersionId: version.id,
      version: version.version,
      checksum: version.checksum,
    });
    const ledgerBefore = await this.ledgerLength(scope);
    const head = this.ledger
      .filter((l) => l.recordId === record!.id)
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
    this.ledger.push(promotion);
    await this.updateProposal(proposal.id, { status: "merged" });
    const row = this.proposals.find((p) => p.id === proposal.id)!;
    Object.assign(row, {
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

export const REPO: SteeringRepository = {
  owner: "a-intel",
  repo: "platform",
  fullName: "a-intel/platform",
  defaultBranch: "main",
};

export class FakeGitHub implements SteeringGitHub {
  /** `${ref}:${path}` → content. */
  files = new Map<string, string>();
  branches: { branch: string; from: string }[] = [];
  commits: { path: string; branch: string; message: string }[] = [];
  pulls: {
    number: number;
    title: string;
    head: string;
    base: string;
    body: string;
  }[] = [];
  checkRuns: {
    name: string;
    headSha: string;
    conclusion: string;
    summary: string;
  }[] = [];
  merges: { number: number; commitTitle: string }[] = [];
  /** Set to make check-run creation answer like a non-App token (403). */
  checksRefused = false;
  /** Set to make the merge refused by GitHub (a required review). */
  mergeRefusedWith: string | null = null;
  repository: SteeringRepository | null = REPO;
  private prNumber = 518;
  private commitNo = 0;

  constructor(files: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(files)) this.files.set(k, v);
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
    return this.files.get(`${ref}:${path}`) ?? null;
  }
  async ensureBranch(_repo: SteeringRepository, branch: string, from: string) {
    if (this.branches.some((b) => b.branch === branch)) return;
    this.branches.push({ branch, from });
    for (const [key, content] of this.files) {
      if (key.startsWith(`${from}:`))
        this.files.set(`${branch}:${key.slice(from.length + 1)}`, content);
    }
  }
  async putFile(
    _repo: SteeringRepository,
    args: { path: string; content: string; message: string; branch: string },
  ) {
    this.files.set(`${args.branch}:${args.path}`, args.content);
    this.commits.push({
      path: args.path,
      branch: args.branch,
      message: args.message,
    });
    this.commitNo += 1;
    return { commitSha: `head${this.commitNo}` };
  }
  async openPullRequest(
    _repo: SteeringRepository,
    args: { title: string; head: string; base: string; body: string },
  ) {
    this.prNumber += 1;
    this.pulls.push({ number: this.prNumber, ...args });
    return {
      number: this.prNumber,
      htmlUrl: `https://github.com/a-intel/platform/pull/${this.prNumber}`,
    };
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
    args: { number: number; commitTitle: string },
  ) {
    if (this.mergeRefusedWith) {
      const { HandlerError } = await import("@oxagen/oxagen");
      throw new HandlerError({
        code: "conflict",
        reason: "github_refused",
        message: this.mergeRefusedWith,
      });
    }
    this.merges.push(args);
    const pr = this.pulls.find((p) => p.number === args.number);
    if (pr) {
      for (const [key, content] of this.files) {
        if (key.startsWith(`${pr.head}:`))
          this.files.set(
            `${pr.base}:${key.slice(pr.head.length + 1)}`,
            content,
          );
      }
    }
    return { sha: `merge${args.number}` };
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
  return {
    store: new MemoryStore(),
    github: new FakeGitHub(files),
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
