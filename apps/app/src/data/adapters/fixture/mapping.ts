// THE mapping from the mockup's demo data (mc.html @ mc-baseline-w1, in its own
// vocabulary) to the view-model contracts (the spec's vocabulary). Plan W3
// requires this to happen once, in one file; nothing else reads ./raw.
//
// Vocabulary (W3):
//   replay grade   full → fork (retry on Stella, spec §8.4), partial → view,
//                  digest → inspect, ledger → inspect; IAM render → view, re-run → retry
//   egress         third_party → third_party, internal → org_tenant, none → local
//   schema origin  observed → observed_proposed
//   financial      fin moves_funds → consequence tag moves_money; commits_spend stays a
//                  customer tag (§6.9 lets customers define tags)
//   agent status   enrolled → active
//   verdict        null → none
//   money          "2,450.00" dollars → { micros: "2450000000" }; never parseFloat
//   times          "09:14:02" → 2026-09-11T09:14:02Z; "2 min ago" → FIXTURE_NOW − 2 min
//   severity       info → 1, warning → 3, critical → 10
//   org roles      org.owner → owner, org.billing → billing, org.auditor → compliance,
//                  workspace.owner → member (org) + owner (workspace)
//
// Integrity repairs (W4), each also caught by integrity.test.ts:
//   - EVIDENCE fnd_01K5RTGH names acme.finops.cost-reporter, an agent AGENTS does not
//     have. SPEND.byTool, the invoice-bot belt and the cited runs all put that tool on
//     acme.finops.invoice-bot, so the evidence points there.
//   - INCIDENTS and RECEIPTS cite run_01K5RH8M2V for the triage run the rest of the
//     mockup calls run_01K5RH3G8K5PAS7D (approval apr_01K5RH8M2): same run.
//   - Run ids the mockup cites from outside its twelve seeded runs (older evidence
//     runs, a few notifications, incidents and receipts) keep their prose but carry
//     no run link, so nothing links to a run that is not in the record.
//   - The approval-waiting and run-proven notifications named runs outside the seed;
//     they now name the seeded approval (apr_01K5RS3K7) and flip (run_01K5RQ4B9C7XTN2P)
//     they describe.
//   - Sofia Ruiz and Helena Vogt act in AUDIT, APIKEYS, EXPORTS, ERASURE and RECEIPTS
//     but are missing from PEOPLE; they are added as members.
//   - Mandates are keyed by id and frames by run: FRAMES belongs to run_01K5RS7M2E8FJ3QW,
//     whose approval (seq 15, apr_01K5RS3K7) it ends on.
import type {
  AgentDefinition,
  AgentDetail,
  ApprovalItem,
  AuditEvent,
  Avatar,
  Budget,
  ConsequenceTag,
  Connection,
  CostBasis,
  DownscopeMethod,
  EgressClass,
  Finding,
  FindingEvidence,
  FindingFix,
  Frame,
  FrameKind,
  Incident,
  KillSwitch,
  Member,
  Meter,
  Money,
  Notification,
  ObservedSchemaProposal,
  OrgRole,
  Person,
  Receipt,
  ReceiptFact,
  ReplayGrade,
  Role,
  RunDetail,
  RunGraph,
  RunProof,
  Severity,
  SpendDrill,
  SpendSlice,
  ToolServer,
  ToolVersion,
  Toolbelt,
  TranscriptEntry,
  WasteCause,
} from "@/data/contracts";
import type { Seed } from "./seed-schema";
import type rawJson from "./raw/mc-baseline-w1.json";
import type * as markupRows from "./raw/markup-rows";

export type RawMockup = typeof rawJson;
export type RawMarkup = typeof markupRows;

/** The demo record is read at this instant. Every mockup clock sits at or before it. */
export const FIXTURE_NOW = "2026-09-11T16:00:00Z";
const DEMO_DAY = "2026-09-11";
const CURRENCY = "USD";

/** Run ids the mockup uses for the same run under two names. */
const RUN_ID_REPAIRS: Readonly<Record<string, string>> = {
  run_01K5RH8M2V: "run_01K5RH3G8K5PAS7D",
};
/** Evidence agents that are not in AGENTS, and the agent the rest of the mockup names. */
const EVIDENCE_AGENT_REPAIRS: Readonly<Record<string, string>> = {
  "acme.finops.cost-reporter": "acme.finops.invoice-bot",
};

export class MappingError extends Error {
  readonly code = "fixture_mapping_unknown_value";
  constructor(what: string, value: unknown) {
    super(`fixture mapping: unknown ${what} ${JSON.stringify(value)}`);
    this.name = "MappingError";
  }
}

// ---- scalar helpers -------------------------------------------------------------

/** A value the mockup always carries. Missing means the mockup changed shape: fail loudly. */
export function req<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new MappingError(what, value);
  return value;
}

type Columns<N extends number, R extends string[] = []> = R["length"] extends N
  ? R
  : Columns<N, [...R, string]>;

/** The first `n` columns of a mockup row or split, as strings. Fewer means the mockup changed shape. */
export function cols<N extends number>(
  values: ReadonlyArray<string | number>,
  n: N,
  what: string,
): Columns<N> {
  if (values.length < n) throw new MappingError(what, values);
  return values.slice(0, n).map(String) as Columns<N>;
}

/** A keyed collection's own entry; the mockup keys some collections by agent. */
function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function pick<V>(
  table: Readonly<Record<string, V>>,
  key: string,
  what: string,
): V {
  const value = table[key];
  if (value === undefined) throw new MappingError(what, key);
  return value;
}

/** Dollars as the mockup writes them ("2,450.00", "-193.08", 6204.18) → integer micros. */
export function toMicros(dollars: string | number): string {
  const text =
    typeof dollars === "number"
      ? dollars.toFixed(6)
      : dollars.replace(/[$,\s]|USD/g, "");
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new MappingError("amount", dollars);
  const [sign, whole] = cols(match.slice(1, 3), 2, "amount");
  const fraction = match[3] ?? "";
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return micros === 0n ? "0" : `${sign}${micros.toString()}`;
}

export function money(dollars: string | number, basis?: CostBasis): Money {
  return basis
    ? { micros: toMicros(dollars), currency: CURRENCY, basis }
    : { micros: toMicros(dollars), currency: CURRENCY };
}

/** "—" and "" mean absent in the mockup. */
function present(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" || value === "—"
    ? null
    : value;
}

/**
 * A mockup clock → an ISO instant. Accepts "09:14:02", "09:07:02.140", "09:31:08Z",
 * "2026-09-10 23:12", "2026-09-10 23:12 UTC", "2026-09-11 06:00Z" and "2026-03-02".
 */
export function toInstant(clock: string, day: string = DEMO_DAY): string {
  const text = clock.trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(text);
  if (dateOnly) return `${req(dateOnly[1], "date")}T00:00:00Z`;
  const match =
    /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(?:Z|UTC)?$/.exec(
      text,
    );
  if (!match) throw new MappingError("clock", clock);
  const [, date = day, hh, mm, ss = "00", fraction = ""] = match;
  return `${date}T${req(hh, "hour")}:${req(mm, "minute")}:${ss}${fraction}Z`;
}

/** "2 min ago", "2 min", "2 h ago" → FIXTURE_NOW minus that. */
export function fromRelative(ago: string): string {
  const match = /^(\d+)\s*(min|h|d)(?: ago)?$/.exec(ago.trim());
  if (!match) throw new MappingError("relative time", ago);
  const unit = { min: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "min" | "h" | "d"
  ];
  return new Date(Date.parse(FIXTURE_NOW) - Number(match[1]) * unit)
    .toISOString()
    .replace(".000Z", "Z");
}

function addSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

/** "4m 12s", "47s", "10m" → seconds. */
export function toSeconds(duration: string): number {
  const match = /^(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(duration.trim());
  if (!match || duration.trim() === "")
    throw new MappingError("duration", duration);
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

/** "3,182" → 3182. */
function toCount(text: string): number {
  const value = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(value)) throw new MappingError("count", text);
  return value;
}

function slugKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The mockup's code samples carry syntax-highlight spans; the view model carries text. */
function stripMarkup(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ---- vocabulary tables (W3) -------------------------------------------------------

const EGRESS: Readonly<Record<string, EgressClass>> = {
  third_party: "third_party",
  internal: "org_tenant",
  none: "local",
};
const CONSEQUENCE: Readonly<Record<string, ConsequenceTag>> = {
  moves_funds: "moves_money",
  commits_spend: "commits_spend",
};
const AGENT_STATUS = { enrolled: "active" } as const;
const IAM_REPLAY: Readonly<Record<string, ReplayGrade>> = {
  fork: "fork",
  "re-run": "retry",
  render: "view",
};
const FRAME_KIND: Readonly<Record<string, FrameKind>> = {
  agent_start: "agent.start",
  "context.assembled": "context.assembled",
  "model.request": "model.request",
  "model.response": "model.response",
  tool_requested: "tool.requested",
  policy_decision: "policy.decision",
  token_issued: "token.issued",
  tool_call: "tool.result",
  "control.steer": "control.steer",
  approval_request: "approval.request",
};
const COST_BASIS: Readonly<Record<string, CostBasis>> = {
  gateway_observed: "gateway_observed",
  client_attested: "client_attested",
  mixed: "mixed",
  estimated: "estimated",
};
const SEVERITY: Readonly<Record<string, Severity>> = {
  info: 1,
  warning: 3,
  critical: 10,
};
const DOWNSCOPE: Readonly<Record<string, DownscopeMethod>> = {
  "installation token": "token_exchange",
  "token exchange": "token_exchange",
  "restricted key": "restricted_key",
  "STS session policy": "session_policy",
  "session policy": "session_policy",
  none: "none",
};

function replayGrade(grade: string, harness: string | undefined): ReplayGrade {
  switch (grade) {
    case "full":
      return harness === "stella" ? "retry" : "fork";
    case "partial":
      return "view";
    case "digest":
    case "ledger":
      return "inspect";
    default:
      throw new MappingError("replay grade", grade);
  }
}

function consequenceTags(fin: string): ConsequenceTag[] {
  return fin === "none"
    ? []
    : fin
        .split(/,\s*/)
        .map((tag) => pick(CONSEQUENCE, tag, "financial effect"));
}

// ---- people ---------------------------------------------------------------------------

type PersonRef = { id: string; name: string };

function personId(name: string): string {
  return `usr_${name.toLowerCase().replace(/[^a-z]/g, "")}`;
}

/** W4 repair: people who act in the mockup but are missing from PEOPLE. */
const ADDED_PEOPLE = [
  {
    key: "sofia",
    name: "Sofia Ruiz",
    email: "sofia@acme.example",
    initials: "SR",
    role: "org.auditor",
    mfa: "passkey",
    lastActive: "2026-09-11 09:41",
  },
  {
    key: "helena",
    name: "Helena Vogt",
    email: "helena@acme.example",
    initials: "HV",
    role: "workspace.member · core-platform",
    mfa: "TOTP",
    lastActive: "2026-09-10 13:02",
  },
] as const;

const ROLE_NAMES: Readonly<
  Record<string, { org: OrgRole; workspace: "owner" | "member" | null }>
> = {
  "org.owner": { org: "owner", workspace: null },
  "org.billing": { org: "billing", workspace: "owner" },
  "org.auditor": { org: "compliance", workspace: null },
  "workspace.owner": { org: "member", workspace: "owner" },
  "workspace.member": { org: "member", workspace: "member" },
};

export function orgRoleOf(role: string): {
  org: OrgRole;
  workspace: { slug: string; role: "owner" | "member" } | null;
} {
  const [name] = cols(role.split(" · "), 1, "role");
  const slug = role.split(" · ")[1];
  const mapped = pick(ROLE_NAMES, name, "role");
  return {
    org: mapped.org,
    workspace:
      mapped.workspace && slug ? { slug, role: mapped.workspace } : null,
  };
}

function mfaFactors(text: string): Array<"passkey" | "totp"> {
  return text
    .split(/\s*\+\s*/)
    .map((factor) =>
      pick({ passkey: "passkey", TOTP: "totp" } as const, factor, "MFA factor"),
    );
}

function avatar(raw: {
  kind: string;
  icon?: string;
  text?: string;
  font?: string;
  tone?: string;
  src?: string;
}): Avatar {
  switch (raw.kind) {
    case "icon":
      return {
        kind: "icon",
        icon: req(raw.icon, "avatar icon"),
        tone: pick(
          { solid: "solid", soft: "soft", line: "line" } as const,
          req(raw.tone, "avatar tone"),
          "tone",
        ),
      };
    case "initials":
      return {
        kind: "initials",
        text: req(raw.text, "avatar text"),
        font: pick(
          { sans: "sans", serif: "serif", mono: "mono" } as const,
          req(raw.font, "avatar font"),
          "font",
        ),
        tone: pick(
          { solid: "solid", soft: "soft", line: "line" } as const,
          req(raw.tone, "avatar tone"),
          "tone",
        ),
      };
    case "photo":
      return { kind: "photo", src: req(raw.src, "avatar src") };
    default:
      throw new MappingError("avatar kind", raw.kind);
  }
}

// ---- the mapping ----------------------------------------------------------------------

export function mapSeed(raw: RawMockup, markup: RawMarkup): Seed {
  const shortNames = Object.entries(raw.PEOPLE).map(([key, p]) => ({
    key,
    name: p.name,
  }));
  const byShort = new Map<string, PersonRef>([
    ...shortNames.map(
      ({ key, name }) => [key, { id: personId(name), name }] as const,
    ),
    ...ADDED_PEOPLE.map(
      (p) => [p.key, { id: personId(p.name), name: p.name }] as const,
    ),
  ]);
  /** A person by short key ("marcus") or full name ("Marcus Bell"). Unknown names still get a stable id. */
  const who = (nameOrKey: string): string =>
    byShort.get(nameOrKey)?.id ?? personId(nameOrKey);
  const isPersonName = (name: string): boolean =>
    [...byShort.values()].some((p) => p.name === name);
  const agentKeys = new Set(raw.AGENTS.map((a) => a.key));
  const harnessOf = (key: string) =>
    raw.AGENTS.find((a) => a.key === key)?.harness;
  const runIds = new Set(raw.RUNS.map((r) => r.id));
  /** A run link only when the run is in the record (W4). */
  const runLink = (id: string): string | null => {
    const repaired = RUN_ID_REPAIRS[id] ?? id;
    return runIds.has(repaired) ? repaired : null;
  };
  const repairText = (text: string): string =>
    Object.entries(RUN_ID_REPAIRS).reduce(
      (acc, [from, to]) => acc.split(from).join(to),
      text,
    );

  // ---- organization and people ----
  const organization: Seed["organization"] = {
    slug: raw.ORG.slug,
    name: raw.ORG.name,
    plan: pick(
      { Team: "team", Free: "free", Enterprise: "enterprise" } as const,
      raw.ORG.plan,
      "plan",
    ),
    displayCurrency: raw.ORG.currency,
    billingCurrency: raw.ORG.currency,
    deploymentMode: "cloud",
    region: raw.ORG.region,
    governanceMode: pick(
      { solo: "solo", team: "team", regulated: "regulated" } as const,
      raw.ORG.governance,
      "governance mode",
    ),
    attesterKeyId: raw.ORG.attester,
  };

  const workspaces: Seed["workspaces"] = raw.WS.map((w) => ({
    slug: w.slug,
    name: w.name,
    mainRepo: w.main,
    productionBranch: w.branch,
    linkedRepos: [...w.linked],
    agentCount: w.agents,
    ownerId: who(w.owner),
  }));

  const people: Person[] = [
    ...Object.values(raw.PEOPLE).map((p) => {
      const role = orgRoleOf(p.role);
      return {
        id: personId(p.name),
        name: p.name,
        email: p.email,
        initials: p.initials,
        orgRole: role.org,
        workspaceRoles: role.workspace ? [role.workspace] : [],
        mfa: mfaFactors(p.mfa),
        avatar: avatar(p.avatar),
      };
    }),
    ...ADDED_PEOPLE.map((p) => {
      const role = orgRoleOf(p.role);
      return {
        id: personId(p.name),
        name: p.name,
        email: p.email,
        initials: p.initials,
        orgRole: role.org,
        workspaceRoles: role.workspace ? [role.workspace] : [],
        mfa: mfaFactors(p.mfa),
        avatar: {
          kind: "initials",
          text: p.initials,
          font: "sans",
          tone: "line",
        } as const,
      };
    }),
  ];

  const members: Member[] = [
    ...raw.MEMBERS.map((m) => {
      const person = people.find((p) => p.id === who(m.p));
      return {
        personId: who(m.p),
        role: req(person, "member").orgRole,
        workspaces: req(person, "member").workspaceRoles,
        allWorkspaces: m.ws === "all",
        status: pick(
          { active: "active", invited: "invited", removed: "removed" } as const,
          m.status,
          "member status",
        ),
        lastActiveAt: toInstant(m.last),
        mfa: mfaFactors(m.mfa),
        sso: present(m.sso),
      };
    }),
    ...ADDED_PEOPLE.map((p) => {
      const role = orgRoleOf(p.role);
      return {
        personId: personId(p.name),
        role: role.org,
        workspaces: role.workspace ? [role.workspace] : [],
        allWorkspaces: role.org === "compliance",
        status: "active" as const,
        lastActiveAt: toInstant(p.lastActive),
        mfa: mfaFactors(p.mfa),
        sso: "Okta",
      };
    }),
  ];

  const invitations: Seed["invitations"] = raw.INVITES.map((i) => {
    const role = orgRoleOf(i.role);
    return {
      email: i.email,
      role: role.workspace
        ? {
            scope: "workspace" as const,
            role: role.workspace.role,
            workspaceSlug: role.workspace.slug,
          }
        : { scope: "org" as const, role: role.org },
      invitedById: who(i.by),
      sentOn: i.sent,
      expiresOn: i.expires,
    };
  });

  const apiKeys: Seed["apiKeys"] = raw.APIKEYS.map((k) => ({
    name: k.name,
    maskedKey: k.key,
    principal: k.principal,
    grants: [...k.grants],
    createdById: who(k.by),
    lastUsedAt: k.last === "never used" ? null : toInstant(k.last),
    uses30d: k.n30,
    expiresOn: k.expires,
    status: pick(
      { ok: "ok", expiring: "expiring", unused: "unused" } as const,
      k.st,
      "API key status",
    ),
  }));

  const dataPlanes: Seed["dataPlanes"] = markup.DATA_PLANE_ROWS.map((row) => ({
    store: row.store,
    mode: pick(
      { shared: "shared", dedicated: "dedicated" } as const,
      raw.ORG.dataPlane,
      "data plane mode",
    ),
    status: "active",
    region: raw.ORG.region,
    isolation: row.isolation,
  }));

  const modelFunding: Seed["modelFunding"] = {
    source: markup.FUNDING.source,
    monthlyCap: money(markup.FUNDING.cap),
    usedThisMonth: money(markup.FUNDING.used),
    routes: markup.FUNDING.routes.map((r) => ({
      tier: r.tier,
      route: r.route,
      resolvesTo: r.resolves,
      fallback: r.fallback,
    })),
  };

  const roles: Role[] = raw.ROLES.map((r) => ({
    name: r.id,
    principalKind: pick(
      { human: "human", agent: "agent", service: "service" } as const,
      r.kind,
      "principal kind",
    ),
    scope: pick(
      {
        organization: "org",
        workspace: "workspace",
        repository: "workspace",
      } as const,
      r.scope,
      "role scope",
    ),
    resourceKind: r.scope === "repository" ? "repository" : null,
    builtin: r.builtin,
    description: r.desc,
    permissions: [...r.perms],
    createdById: r.by ? who(r.by) : null,
    createdOn: r.at ?? null,
  }));

  const PERMISSION_GROUP = {
    Runs: "runs",
    Agents: "agents",
    "Tools and policy": "tools_policy",
    Repository: "repository",
    "Graph and steering": "graph_steering",
    Money: "money",
    Audit: "audit",
  } as const;
  const permissionGroups: Seed["permissionGroups"] = raw.PERMS.map(
    ([label, perms]) => ({
      key: pick(PERMISSION_GROUP, String(label), "permission group"),
      permissions: [...(perms as string[])],
    }),
  );

  // ---- agents ----
  const agents: AgentDetail[] = raw.AGENTS.map((a) => {
    const slug = req(a.key.split(".").pop(), "agent slug");
    return {
      key: a.key,
      name: a.name,
      description: a.desc,
      harness: pick(
        {
          stella: "stella",
          "claude-code": "claude-code",
          "codex-cli": "codex-cli",
          "claude-agent-sdk": "claude-agent-sdk",
          "openai-agents-sdk": "openai-agents-sdk",
          custom: "custom",
        } as const,
        a.harness,
        "harness",
      ),
      harnessVersion: a.harnessV,
      workspaceSlug: a.ws,
      operatorId: who(a.operator),
      status: pick(AGENT_STATUS, a.status, "agent status"),
      tier: pick(
        { gateway: "gateway", harness: "harness", observe: "observe" } as const,
        a.tier,
        "tier",
      ),
      nativeTier: pick(
        { gateway: "gateway", harness: "harness", observe: "observe" } as const,
        a.tierNative,
        "tier",
      ),
      beltSize: a.belt,
      beltMode: pick(
        { full: "full", searchable: "searchable" } as const,
        a.beltMode,
        "belt mode",
      ),
      runs30d: a.runs30,
      spend30d: money(a.spend30, "mixed"),
      proven30d: money(a.proven30, "mixed"),
      productiveRatio: a.ratio,
      // One source of truth: the audit record's open incidents scoped to this agent.
      openIncidents: raw.INCIDENTS.filter(
        (i) => i.status === "open" && i.scope.startsWith(a.key),
      ).length,
      mandateIds: [...a.mandates],
      modelTier: pick(
        { light: "light", complex: "complex" } as const,
        a.model,
        "model tier",
      ),
      avatar: avatar(a.avatar),
      identity: {
        principalId: a.principal,
        host: a.host,
        enrolled: a.enrolled,
        collectorVersion: a.collector,
        deviceKey: a.devKey,
        firstFrameAt: toInstant(a.firstFrame),
        replayGrade: pick(IAM_REPLAY, a.replay, "IAM replay grade"),
      },
      credential: {
        prefix: a.cred,
        issuedAt: toInstant(a.issued),
        lastUsedAt: toInstant(a.lastUsed),
        activeRunTokens: a.tokens,
      },
      definition: {
        path: `.oxagen/agents/${slug}.toml`,
        digest: a.digest,
        commitSha: a.commit,
      },
      budget: {
        perRun: money(a.budget),
        lastRunSpend: money(a.budgetUsed, "mixed"),
        perDay: money(a.budgetDay),
        usedToday: money(a.usedDay),
      },
      roles: req(
        own(raw.AGENT_ROLES, a.key) as string[] | undefined,
        "AGENT_ROLES",
      ).map((assignment: string) => {
        const match = /^([a-z.]+)(?:\((.+)\))?$/.exec(assignment);
        if (!match) throw new MappingError("role assignment", assignment);
        return { role: match[1] ?? assignment, resource: match[2] ?? null };
      }),
    };
  });

  const beltById = new Map(raw.BELT.map((b) => [b.id, b]));
  const toolbelts: Toolbelt[] = raw.AGENTS.map((a) => ({
    agentKey: a.key,
    mode: pick(
      { full: "full", searchable: "searchable" } as const,
      a.beltMode,
      "belt mode",
    ),
    entries: req(
      own(raw.AGENT_BELTS, a.key) as string[] | undefined,
      "AGENT_BELTS",
    ).flatMap((id: string) => {
      const b = req(beltById.get(id), "belt entry");
      return [
        {
          tool: b.id,
          description: b.d,
          decision: pick(
            {
              allow: "allow",
              deny: "deny",
              require_approval: "require_approval",
              mandate: "mandate",
            } as const,
            b.dec,
            "belt decision",
          ),
          rule: b.rule,
          scope: present(b.scope),
          pinned: b.pinned ?? false,
          meta: b.meta ?? false,
          note: b.note ?? null,
        },
      ];
    }),
    outside: raw.BELT_OUTSIDE.map((o) => ({ tool: o.id, reason: o.why })),
    registryVersions: markup.REGISTRY.versions,
    fullBeltLimit: markup.REGISTRY.fullBeltLimit,
  }));

  const definitions: AgentDefinition[] = raw.AGENTS.map((a) => {
    const slug = req(a.key.split(".").pop(), "agent slug");
    return {
      agentKey: a.key,
      path: `.oxagen/agents/${slug}.toml`,
      digest: a.digest,
      commitSha: a.commit,
      source: agentToml(slug, a),
      branches:
        a.ws === "core-platform"
          ? raw.BRANCHES.filter(
              (b) => b.name.includes(slug) || !b.name.startsWith("agents/"),
            ).map((b) => ({
              name: b.name,
              pullRequestRef: b.pr,
              commitsAhead: b.ahead,
              authorId: who(b.by),
            }))
          : [],
    };
  });

  const scores: Seed["scores"] = Object.entries(raw.SCORES).map(
    ([agentKey, s]) => ({ agentKey, trust: s.trust, spend: s.spend }),
  );

  // ---- runs ----
  const runs: RunDetail[] = raw.RUNS.map((r) => {
    const day = /^\d{4}-\d{2}-\d{2}/.exec(r.started)?.[0] ?? DEMO_DAY;
    const basis = pick(
      {
        gateway_observed: "gateway_observed",
        client_attested: "client_attested",
        mixed: "mixed",
        estimated: "estimated",
      } as const,
      r.basis,
      "cost basis",
    );
    return {
      id: r.id,
      name: r.taskTitle,
      agentKey: r.agent,
      operatorId: who(r.op),
      workspaceSlug: r.ws,
      status: pick(
        {
          live: "live",
          parked: "parked",
          sealed: "sealed",
          halted: "halted",
          compacted: "compacted",
        } as const,
        r.status,
        "run status",
      ),
      turns: r.turn,
      steps: r.steps,
      frames: r.frames,
      cost: money(r.cost, basis),
      tier: pick(
        { gateway: "gateway", harness: "harness", observe: "observe" } as const,
        r.tier,
        "tier",
      ),
      grade: replayGrade(r.grade, harnessOf(r.agent)),
      verdict:
        r.verdict === null
          ? "none"
          : pick(
              {
                flipped: "flipped",
                failing: "failing",
                unmoved: "unmoved",
                unsatisfied: "unsatisfied",
                tampered: "tampered",
                unverified: "unverified",
                waived: "waived",
              } as const,
              r.verdict,
              "verdict",
            ),
      taskRef: present(r.task),
      startedAt: toInstant(r.started, day),
      sealedAt: r.sealed === null ? null : toInstant(r.sealed, day),
      model: r.model,
      cacheHitRate: r.cache,
      provenSpend: money(r.provenSpend, basis),
      productiveRatio: r.ratio,
      summary: {
        text: r.summary,
        model: r.gen.model,
        frameCount: r.gen.frames,
        writtenAt: r.gen.when.startsWith("at seal")
          ? "seal"
          : r.gen.when.startsWith("at halt")
            ? "halt"
            : "turn_boundary",
      },
      touched: [...r.touched],
    };
  });

  const liveRunId = "run_01K5RS7M2E8FJ3QW";
  const frames: Seed["frames"] = {
    [liveRunId]: raw.FRAMES.map(
      (f): Frame => ({
        seq: String(f.seq),
        kind: pick(FRAME_KIND, f.kind, "frame kind"),
        ts: toInstant(f.t),
        tier: pick(
          {
            gateway: "gateway",
            harness: "harness",
            observe: "observe",
          } as const,
          f.tier,
          "tier",
        ),
        cost: f.cost === null ? null : money(f.cost, "gateway_observed"),
        summary: f.sum,
        hash: null,
        prevHash: null,
      }),
    ),
  };

  const transcripts: Seed["transcripts"] = Object.fromEntries(
    Object.entries(raw.TRANSCRIPTS).map(([runId, entries]) => [
      runId,
      entries.map((e) => transcriptEntry(e, who)),
    ]),
  );

  const runGraphs: Seed["runGraphs"] = Object.fromEntries(
    Object.entries(raw.RUNGRAPH).map(([runId, g]): [string, RunGraph] => {
      const edge = (x: { edge: string; conf?: number; fr?: number[] }) => ({
        origin: pick(
          {
            observed: "observed",
            stated: "stated",
            inferred: "inferred",
          } as const,
          x.edge,
          "edge origin",
        ),
        confidence: x.conf ?? null,
        frameSeqs: x.fr ? [...x.fr] : [],
      });
      return [
        runId,
        {
          repositories: g.repos.map((x) => ({
            ...edge(x),
            fullName: x.name,
            ref: x.ref,
            note: x.note,
          })),
          issues: g.issues.map((x) => ({
            ...edge(x),
            ref: x.ref,
            title: x.title,
            relation: x.rel,
          })),
          artifacts: g.artifacts.map((x) => ({
            ...edge(x),
            kind: pick(
              {
                branch: "branch",
                release: "release",
                pr: "pr",
                witness: "witness",
                comment: "comment",
              } as const,
              x.kind,
              "artifact kind",
            ),
            ref: x.ref,
            title: x.title,
            state: x.state,
          })),
          files: g.files.map((x) => ({
            path: x.path,
            before: x.before,
            after: x.after,
            note: x.note,
          })),
        },
      ];
    }),
  );

  const request = /seq (\d+) · (\S+)$/.exec(raw.CTXW.req);
  const contextWindows: Seed["contextWindows"] = {
    [liveRunId]: {
      requestFrameSeq: Number(req(request?.[1], "request capture 1")),
      requestedAt: toInstant(req(request?.[2], "request capture 2")),
      totalTokens: raw.CTXW.total,
      cachedTokens: raw.CTXW.cached,
      freshTokens: raw.CTXW.fresh,
      compositionDigest: raw.CTXW.digest,
      budgetTokens: raw.CTXW.budget,
      usedTokens: raw.CTXW.used,
      headroomTokens: raw.CTXW.headroom,
      candidatesScored: raw.CTXW.scored,
      framesAdmitted: raw.CTXW.admitted,
      framesHeld: raw.CTXW.held,
      scoreFloorPercent: raw.CTXW.floor,
      blocks: raw.CTXB.map((b) => ({
        id: pick(
          {
            identity: "identity",
            steering: "steering",
            tools: "tools",
            frames: "frames",
            task: "task",
          } as const,
          b.id,
          "context block",
        ),
        position: b.ix,
        name: b.name,
        tokens: b.tok,
        cache: pick(
          { read: "read", mixed: "mixed", new: "new" } as const,
          b.cache,
          "block cache",
        ),
      })),
      admitted: raw.CTXF.map((f) => ({
        id: f.id,
        kind: contextKind(f.kind),
        tokens: f.tok,
        score: f.score,
        citations: f.cited,
        grain: pick(
          { L0: "L0", L1: "L1", L2: "L2", L3: "L3" } as const,
          f.grain,
          "grain",
        ),
        label: f.label,
        nodeId: f.node,
      })),
      excluded: raw.CTXX.map((x) => ({
        id: x.id,
        kind: contextKind(x.kind),
        tokens: x.tok,
        score: x.score,
        reason: pick(
          { cap: "cap", grain: "grain", permission: "permission" } as const,
          x.why,
          "exclusion reason",
        ),
        label: x.label,
      })),
    },
  };

  const proofs: Seed["proofs"] = Object.fromEntries(
    raw.RUNS.flatMap((r) => {
      const f = r.flip;
      if (!f) return [];
      const day = /^\d{4}-\d{2}-\d{2}/.exec(r.started)?.[0] ?? DEMO_DAY;
      const held = /^(\d+) of (\d+)$/.exec(f.heldOut);
      const proof: RunProof = {
        oracle: pick({ test_flip: "test_flip" } as const, f.oracle, "oracle"),
        testKind: f.testKind,
        runner: f.runner,
        command: f.cmd,
        commandDigest: f.cmdDigest,
        witnessId: f.witness,
        target: { ref: f.targetRef, sha: f.targetSha },
        pullRequest: { ref: f.prRef, sha: f.prSha },
        turn: f.turn,
        turnStart: { at: toInstant(f.turnStart, day), seq: f.turnStartSeq },
        flipped:
          f.flippedAt === null
            ? null
            : { at: toInstant(f.flippedAt, day), seq: f.flipSeq },
        turnEnd: { at: toInstant(f.turnEnd, day), seq: f.turnEndSeq },
        sealed: { at: toInstant(f.sealedAt, day), seq: f.sealSeq },
        fingerprint: pick(
          { held: "held", moved: "moved" } as const,
          f.fingerprint,
          "fingerprint",
        ),
        segmentId: f.segment,
        heldOut: {
          held: Number(req(held?.[1], "held capture 1")),
          of: Number(req(held?.[2], "held capture 2")),
        },
        attempts: f.attempts.map((x) => ({
          n: x.n,
          result: pick(
            { pass: "pass", fail: "fail" } as const,
            x.result,
            "attempt result",
          ),
          at: toInstant(x.at, day),
          seq: x.seq,
          durationMs: x.ms,
          exitCode: x.exit,
          note: x.note,
        })),
      };
      return [[r.id, proof] as const];
    }),
  );

  // ---- approvals and mandates ----
  const approvalClocks: Seed["approvalClocks"] = {};
  const approvals: ApprovalItem[] = raw.APPROVALS.map((a) => {
    const expired = a.waited === "expired";
    const timeoutSeconds = toSeconds(a.timeout);
    approvalClocks[a.id] = {
      waitedSeconds: expired ? timeoutSeconds : toSeconds(a.waited),
      timeoutSeconds,
    };
    const requestedAt = toInstant(a.parkedAt);
    const [ruleKind] = cols(a.rule.split(" · "), 1, "approval rule");
    const ruleRest = a.rule.split(" · ").slice(1);
    const trigger = /^(mandate|role_grant|taint rule) (\S+)$/.exec(ruleKind);
    if (!trigger) throw new MappingError("approval rule", a.rule);
    const [roleClause] = cols(a.approvers.split(" · "), 1, "approvers");
    const exclusions = a.approvers.split(" · ").slice(1);
    const [rolesText, eligibleText] = cols(
      roleClause.split(" — "),
      2,
      "approver roles",
    );
    return {
      id: a.id,
      runId: a.run,
      workspaceSlug: a.ws,
      status: expired ? "expired" : "pending",
      chain: {
        operatorId: who(a.op),
        agentKey: a.agent,
        action: a.tool,
        trigger: {
          kind: pick(
            {
              mandate: "mandate",
              role_grant: "role_grant",
              "taint rule": "taint",
            } as const,
            req(trigger[1], "trigger capture 1"),
            "approval trigger",
          ),
          ref: req(trigger[2], "trigger capture 2"),
          detail: ruleRest.join(" · "),
        },
      },
      risk: pick(
        {
          low: "low",
          medium: "medium",
          high: "high",
          critical: "critical",
        } as const,
        a.risk,
        "risk",
      ),
      sideEffect: pick(
        { read: "read", write: "write", irreversible: "irreversible" } as const,
        a.side,
        "side effect",
      ),
      egress: pick(EGRESS, a.egress, "egress"),
      amount: a.amount === null ? null : money(a.amount),
      counterparty: a.counterparty,
      mandateId: a.mandate,
      policyVersionId: a.policy,
      inputDigest: a.digest,
      tainted: a.tainted,
      tier: pick(
        { gateway: "gateway", harness: "harness", observe: "observe" } as const,
        a.tier,
        "tier",
      ),
      requestedAt,
      expiresAt: addSeconds(requestedAt, timeoutSeconds),
      approvers: {
        roles: rolesText.split(/,\s*/).filter(Boolean),
        eligiblePersonIds: eligibleText.split(/,\s*/).filter(Boolean).map(who),
        excluded: exclusions.flatMap((clause) => {
          const m =
            /^(.+?) is the operator of this run and is excluded by (\S+)$/.exec(
              clause,
            );
          return m
            ? [
                {
                  personId: who(req(m[1], "m capture 1")),
                  rule: req(m[2], "m capture 2"),
                },
              ]
            : [];
        }),
      },
      rules: a.rules.map((rule) => ({
        id: rule.id,
        verdict: pick(
          {
            allow: "allow",
            approve: "approve",
            constrain: "constrain",
            deny: "deny",
          } as const,
          rule.v,
          "rule verdict",
        ),
        text: rule.text,
      })),
      taintSources: (a.taint ?? []).map((t) => ({
        frameSeq: t.frame,
        tool: t.tool,
        path: t.path,
        note: t.note,
      })),
    };
  });

  const mandates: Seed["mandates"] = raw.MANDATES.map((m) => ({
    id: m.id,
    agentKey: m.agent,
    grantedById: who(m.by),
    roleAtGrant: m.roleAt,
    secondApproverId: who(m.second),
    twoPerson: m.twoPerson,
    consequenceTags: consequenceTags(m.effect),
    limits: {
      perCall: money(m.perCall),
      perPeriod: money(m.perPeriod),
      period: pick(
        { daily: "daily", weekly: "weekly", monthly: "monthly" } as const,
        m.period,
        "mandate period",
      ),
      callsPerDay: m.callsPerDay,
    },
    usage: {
      settled: money(m.used),
      reserved: money(m.reserved),
      remaining: money(m.remaining),
    },
    counterparties: {
      allow: m.allow.split(/,\s*/),
      deny: m.deny.split(/,\s*/),
    },
    tools: m.tools.split(/,\s*/),
    approval: {
      humanAbove: money(m.approvalAbove),
      alwaysHumanFor: consequenceTags(m.alwaysFor),
      approvers: m.approvers.split(/,\s*/),
    },
    purpose: m.purpose,
    validFrom: m.from,
    validTo: m.to,
    status: pick(
      {
        active: "active",
        suspended: "suspended",
        expired: "expired",
        revoked: "revoked",
      } as const,
      m.status,
      "mandate status",
    ),
  }));

  const mandateLedger: Seed["mandateLedger"] = markup.MANDATE_LEDGER_ROWS.map(
    (row) => ({
      mandateId: row.mandate,
      at: toInstant(row.when),
      tool: row.call,
      kind: pick(
        {
          reserved: "reserve",
          settled: "settle",
          released: "release",
        } as const,
        row.state,
        "ledger state",
      ),
      amount: money(row.amount),
      externalEffectId: row.external,
      note: row.note,
      receiptId: row.receipt,
      periodKey: "2026-09",
    }),
  );

  // ---- tools ----
  const connections: Connection[] = raw.CONNECTIONS.map((c) => ({
    id: c.id,
    kind: pick(
      {
        github_app: "github_app",
        oauth: "oauth",
        api_key: "api_key",
        cloud_role: "cloud_role",
        model_provider: "model_provider",
      } as const,
      c.kind,
      "connection kind",
    ),
    name: c.name,
    ownerId: who(c.owner),
    serverIds: c.servers.split(/,\s*/),
    reviewedOn: c.reviewed,
    reviewOn: c.next,
    grants30d: c.grants30,
    status: "active",
    requiresMandate: c.status.includes("financial"),
    downscope: pick(DOWNSCOPE, c.downscope, "downscope"),
  }));

  const switchOn = (level: string, target: string) =>
    raw.SWITCHES.some((s) => s.on && s.lvl === level && s.target === target);

  const servers: ToolServer[] = raw.SERVERS.map((s) => ({
    id: s.id,
    name: s.name,
    kind: pick(
      {
        MCP: "mcp",
        HTTP: "http",
        Harness: "harness",
        "Agent tools": "oxagen",
      } as const,
      s.kind,
      "server kind",
    ),
    transport: pick(
      {
        "streamable-http": "streamable_http",
        stdio: "stdio",
        https: "openapi",
        "in-process": "builtin",
        hook: "builtin",
      } as const,
      s.transport,
      "transport",
    ),
    endpoint: s.url,
    toolCount: s.tools,
    versionCount: s.versions,
    status: switchOn("Tool server", s.id) ? "killed" : "active",
    health: pick(
      { ok: "ok", degraded: "degraded" } as const,
      s.health,
      "server health",
    ),
    lastImportAt: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s.imported)
      ? toInstant(s.imported)
      : null,
    connectionId:
      connections.find((c) => c.serverIds.includes(s.id))?.id ?? null,
    pendingSchemaCount: raw.TOOLS.filter(
      (t) => t.s === s.id && t.proposal === true,
    ).length,
  }));

  const toolVersions: ToolVersion[] = raw.TOOLS.map((t) => {
    const [kind] = cols(t.cred.split(" → "), 1, "credential");
    const downscope = t.cred.split(" → ")[1] ?? "none";
    return {
      name: t.n,
      version: t.v,
      serverId: t.s,
      risk: pick(
        {
          low: "low",
          medium: "medium",
          high: "high",
          critical: "critical",
        } as const,
        t.risk,
        "risk",
      ),
      sideEffect: pick(
        { read: "read", write: "write", irreversible: "irreversible" } as const,
        t.eff,
        "side effect",
      ),
      egress: pick(EGRESS, t.eg, "egress"),
      consequenceTags: consequenceTags(t.fin),
      schemaOrigin: pick(
        {
          declared: "declared",
          imported: "imported",
          observed: "observed_proposed",
          observed_approved: "observed_approved",
        } as const,
        t.origin,
        "schema origin",
      ),
      schemaDigest: t.dig === "sha256:pending" ? null : t.dig,
      price: t.price === "0.00" ? null : money(t.price),
      credential: {
        connectionKind:
          kind === "none"
            ? null
            : pick(
                {
                  github_app: "github_app",
                  api_key: "api_key",
                  cloud_role: "cloud_role",
                  oauth: "oauth",
                } as const,
                kind,
                "credential kind",
              ),
        downscope: pick(DOWNSCOPE, downscope, "downscope"),
      },
      measures: {
        amount: t.amount ?? null,
        currency: t.currency ?? null,
        counterparty: t.party ?? null,
        idempotencyKey: t.idem ?? null,
      },
      beltCount: t.belts,
      calls30d: t.calls30,
    };
  });

  const observedSchemas: ObservedSchemaProposal[] = raw.TOOLS.filter(
    (t) => t.proposal === true,
  ).map((t) => {
    const html = raw.OBSERVED_SCHEMAS[t.n as keyof typeof raw.OBSERVED_SCHEMAS];
    const sample =
      raw.OBSERVED_SAMPLES[t.n as keyof typeof raw.OBSERVED_SAMPLES];
    const notes = [
      ...html.matchAll(/"(\w+)":[^\n]*<span class="c">\/\/ ([^<]+)<\/span>/g),
    ].map((m) => `${req(m[1], "m capture 1")}: ${req(m[2], "m capture 2")}`);
    return {
      tool: t.n,
      version: t.v,
      schema: stripMarkup(
        html.replace(/\s*<span class="c">\/\/[^<]*<\/span>/g, ""),
      ),
      sample: stripMarkup(sample),
      notes,
    };
  });

  const SWITCH_LEVEL = {
    Organization: "org",
    Workspace: "workspace",
    Class: "class",
    "Tool server": "tool_server",
    "Tool version": "tool_version",
    Connection: "connection",
    Agent: "agent",
    "Operator’s agents": "operator",
  } as const;
  const CLASS_TARGET: Readonly<Record<string, string>> = {
    "every moves_funds tool": "consequence:moves_money",
    "every irreversible tool": "side_effect:irreversible",
    "every tool with egress: third_party": "egress:third_party",
  };
  const killSwitches: KillSwitch[] = raw.SWITCHES.map((s) => {
    const level = pick(SWITCH_LEVEL, s.lvl, "switch level");
    const count = (pattern: RegExp) => {
      const m = pattern.exec(s.stops);
      return m ? toCount(req(m[1], "m capture 1")) : null;
    };
    return {
      id: `ksw_${s.id.replace(/^ks_/, "").replace(/_/g, "")}`,
      level,
      target:
        level === "class"
          ? pick(CLASS_TARGET, s.target, "switch class")
          : level === "operator"
            ? who(s.target)
            : level === "connection"
              ? req(s.target.split(" · ")[0], "connection target")
              : s.target,
      on: s.on,
      headline: s.headline ?? false,
      flippedById: s.by ? who(s.by) : null,
      flippedAt: s.at ? toInstant(s.at) : null,
      reason: s.why,
      blastRadius: {
        agents: count(/([\d,]+) agents?\b/),
        toolVersions: count(/([\d,]+) tool versions?/),
        mandates: count(/([\d,]+) mandates?/),
        runsInFlight: count(/([\d,]+) runs? in flight/),
        grants24h: count(/([\d,]+) grants in the last 24h/),
      },
    };
  });

  const autoApprovalRules: Seed["autoApprovalRules"] = raw.AUTORULES.map(
    (r) => ({
      id: r.id,
      name: r.name,
      tool: r.tool,
      workspaceSlug: r.ws,
      minTrust: r.minTrust,
      minSpendScore: r.minSpend,
      maxAmount: r.maxAmount === null ? null : money(r.maxAmount),
      enabled: r.on,
      createdById: who(r.by),
      createdOn: r.at,
      hits30d: r.hits30,
      skipped30d: r.skipped30,
    }),
  );

  const assurance: Seed["assurance"] = {
    suiteVersion: raw.ASSURANCE.version.replace(/^suite /, ""),
    ranAt: toInstant(raw.ASSURANCE.ran),
    against: raw.ASSURANCE.against,
    passed: raw.ASSURANCE.pass,
    failed: raw.ASSURANCE.fail,
    notApplicable: raw.ASSURANCE.na,
    cases: raw.ASSURANCE.cases.map((c) => ({
      name: c.c,
      result: pick(
        { pass: "pass", fail: "fail", "n/a": "not_applicable" } as const,
        c.r,
        "assurance result",
      ),
      detail: c.d,
    })),
  };

  const policyVersions: Seed["policyVersions"] = raw.POLICIES.map((p) => {
    const tests = /^(\d+) \/ (\d+)/.exec(p.tests);
    return {
      id: p.v,
      version: Number(p.v.replace(/^pol_v/, "")),
      status: pick(
        {
          active: "active",
          superseded: "superseded",
          "draft · simulated": "simulated",
          draft: "draft",
        } as const,
        p.state,
        "policy status",
      ),
      authoredById: who(p.by),
      authoredAt: toInstant(p.at),
      ruleCount: p.rules,
      tests: {
        passed: Number(req(tests?.[1], "tests capture 1")),
        total: Number(req(tests?.[2], "tests capture 2")),
      },
      note: p.note,
    };
  });
  const simulated = req(
    policyVersions.find((p) => p.status === "simulated"),
    "simulated policy version",
  );
  const policySimulations: Seed["policySimulations"] = [
    {
      policyVersionId: simulated.id,
      days: raw.SIM.days,
      calls: raw.SIM.calls,
      wouldDeny: raw.SIM.nowDenied,
      wouldRequireApproval: raw.SIM.nowApproval,
      wasDeniedNowAllowed: raw.SIM.wasDeniedNowAllowed,
      unchanged: raw.SIM.unchanged,
      agentsAffected: [...raw.SIM.agentsAffected],
    },
  ];

  // ---- ontology ----
  const classes: Seed["classes"] = raw.CLASSES.map((c) => ({
    name: c.n,
    entityCount: c.ents,
    freshAt: fromRelative(c.fresh),
    sources: c.src.split(/,\s*/),
    relations: c.rel.split(/,\s*/),
    citedByAgents: c.cited,
    rulesReferencing: c.rules,
    provenRuns: c.proven,
    driftFindings: c.drift,
    builtin: c.builtin,
  }));
  const sources: Seed["sources"] = raw.SOURCES.map((s) => ({
    name: s.n,
    kind: pick(
      { github: "github", linear: "linear", postgres: "postgres" } as const,
      s.kind,
      "source kind",
    ),
    records: s.records,
    lastSyncAt: fromRelative(s.last),
    health: pick(
      { ok: "ok", degraded: "degraded", failed: "failed" } as const,
      s.health,
      "sync health",
    ),
    cursor: s.cursor,
    entities: s.entities.split(/,\s*/),
  }));
  const repositories: Seed["repositories"] = raw.REPOS.map((r) => {
    const imported = /([\d,]+) imported/.exec(r.issues);
    const events =
      /^(\w+) · ([\d,]+) deliveries \/ 30d · (\d+) gaps?( recovered)?$/.exec(
        r.events,
      );
    if (!events) throw new MappingError("repository events", r.events);
    const gaps = Number(req(events[3], "events capture 3"));
    const drift = /^(\d+) data-layer findings?$/.exec(r.drift);
    return {
      fullName: r.n,
      role: pick(
        { main: "main", linked: "linked" } as const,
        r.role,
        "repository role",
      ),
      productionBranch: r.branch,
      lastIndexedSha: r.head,
      lastIndexedAt: fromRelative(r.indexed),
      issues: {
        enabled: r.issues.startsWith("enabled"),
        imported: imported
          ? toCount(req(imported[1], "imported capture 1"))
          : 0,
      },
      events: {
        health: pick(
          { ok: "ok", degraded: "degraded", failed: "failed" } as const,
          req(events[1], "events capture 1"),
          "event health",
        ),
        deliveries30d: toCount(req(events[2], "events capture 2")),
        gaps: events[4] ? 0 : gaps,
        gapsRecovered: events[4] ? gaps : 0,
      },
      symbols: r.symbols,
      dataLayerDrift: drift ? Number(drift[1]) : 0,
    };
  });
  const ontologyVersions: Seed["ontologyVersions"] = raw.ONTVERSIONS.map(
    (v) => ({
      version: v.v,
      status: pick(
        {
          active: "active",
          superseded: "superseded",
          "open proposal": "proposed",
        } as const,
        v.state,
        "ontology version status",
      ),
      commitSha: present(v.commit),
      at: toInstant(v.at),
      authoredById: isPersonName(v.by) ? who(v.by) : null,
      pullRequestRef: v.pr,
      diffSummary: v.diff,
    }),
  );
  const embeddingIndexes: Seed["embeddingIndexes"] = raw.INDEXES.map((i) => {
    const [name, model] = cols(i.n.split(" · "), 2, "index name");
    return {
      name,
      model,
      dimensions: i.dims,
      nodes: i.nodes,
      recall: i.recall,
      citationRate: i.cite,
      status: pick(
        {
          current: "current",
          "upgrade available": "upgrade_available",
        } as const,
        i.state,
        "index status",
      ),
    };
  });

  // ---- steering ----
  const FORCE = {
    must: "must",
    should: "should",
    may: "may",
    info: "info",
  } as const;
  const KIND = {
    rule: "rule",
    constraint: "constraint",
    procedure: "procedure",
    fact: "fact",
    memory: "memory",
    preference: "preference",
  } as const;
  const records: Seed["records"] = raw.RECORDS.map((r) => {
    const effect = /^rendered (\d+) · cited (\d+) · violated (\d+)$/.exec(
      r.effect,
    );
    if (!effect) throw new MappingError("record effect", r.effect);
    return {
      lineage: r.id,
      kind: pick(KIND, r.kind, "record kind"),
      force: pick(FORCE, r.force, "record force"),
      enforcement: r.ce
        ? pick(
            { require: "require", forbid: "forbid" } as const,
            r.ce,
            "record enforcement",
          )
        : null,
      scope: pick(
        { workspace: "workspace", repository: "repository" } as const,
        r.scope,
        "record scope",
      ),
      status: pick(
        { published: "published", archived: "archived" } as const,
        r.status,
        "record status",
      ),
      statement: r.st,
      effect: {
        rendered: Number(effect[1]),
        cited: Number(effect[2]),
        violated: Number(effect[3]),
      },
      commitSha: r.commit,
      publishedOn: r.pub,
    };
  });
  const proposals: Seed["proposals"] = raw.PROPOSALS.map((p) => {
    const [sourceKind] = cols(p.from.split(" · "), 1, "proposal source");
    const sourceRef = p.from.split(" · ")[1];
    const checks = /^(\d+) \/ (\d+)( · .*running)?/.exec(p.checks);
    return {
      id: p.id,
      lineage: p.lineage,
      kind: pick(KIND, p.kind, "record kind"),
      force: pick(FORCE, p.force, "record force"),
      source:
        sourceKind === "findings job"
          ? {
              kind: "findings_job" as const,
              ref: req(sourceRef, "proposal source"),
            }
          : sourceKind === "reflector"
            ? {
                kind: "reflector" as const,
                ref: req(sourceRef, "proposal source"),
              }
            : { kind: "person" as const, ref: who(sourceKind) },
      statement: p.st,
      support: p.support,
      state: pick(
        {
          "open Context PR": "open_context_pr",
          candidate: "candidate",
        } as const,
        p.state,
        "proposal state",
      ),
      pullRequestRef: present(p.pr),
      checks: checks
        ? {
            passed: Number(checks[1]),
            total: Number(checks[2]),
            running: Boolean(checks[3]),
          }
        : null,
    };
  });
  const recordEffects: Seed["recordEffects"] = markup.STEERING_EFFECT_ROWS.map(
    (row) => ({
      lineage: row.lineage,
      kind: row.kind,
      rendered: row.rendered,
      cited: row.cited,
      violated: row.violated,
      proofRateBefore: row.before,
      proofRateAfter: row.after,
      recommendation: row.verdict,
    }),
  );
  const retirementCandidates: Seed["retirementCandidates"] =
    markup.RETIREMENT_ROWS.map((row) => ({
      lineage: row.lineage,
      kind: row.kind,
      publishedOn: row.published,
      rendered: row.rendered,
      cited: row.cited,
      reason: row.why,
      archivedOn: row.archived,
    }));

  // ---- spend ----
  const S = raw.SPEND;
  const trendPercent = (trend: string) => Number(trend.replace("%", ""));
  const WASTE_CAUSE: Readonly<Record<string, WasteCause>> = {
    "unproven outcome": "unproven_outcome",
    "cache misses": "cache_misses",
    "retry loops": "retry_loops",
    "context bloat": "context_bloat",
    "idle while parked": "idle_while_parked",
    "halted early": "halted_early",
  };
  const FINDING_KIND = {
    "Unpaged results": "unpaged_results",
    "Repeated shell commands": "repeated_shell_commands",
    "Tool-list bloat": "tool_list_bloat",
    "Cache misses after a stable prefix changed":
      "cache_misses_after_prefix_change",
    "Refetching a stable list": "refetching_stable_list",
    "Duplicate tool calls": "duplicate_tool_calls",
    "Wrong tier": "wrong_tier",
    "Unproductive tail": "unproductive_tail",
    "Cache writes never read": "cache_writes_never_read",
  } as const;
  const drillable = new Set(Object.keys(raw.SPEND_DETAIL));
  const slices = (
    rows: ReadonlyArray<ReadonlyArray<string | number>> | undefined,
    kind: "agent" | "operator" | "tool" | "model",
  ): SpendSlice[] =>
    (rows ?? []).map(([name, spend]) => {
      const label = String(name);
      const isDrillable = kind !== "model" && drillable.has(`${kind}:${label}`);
      const key = isDrillable
        ? kind === "operator"
          ? who(label)
          : label
        : null;
      return {
        key,
        label:
          kind === "operator"
            ? req(byShort.get(label), "operator").name
            : label,
        spend: money(Number(spend), "mixed"),
      };
    });

  const spend: Seed["spend"] = {
    summary: {
      period: "2026-09",
      total: money(S.spend, "mixed"),
      proven: money(S.proven, "mixed"),
      accepted: money(S.accepted, "mixed"),
      unproven: money(S.unproven, "mixed"),
      productiveRatio: S.ratio,
      cacheHitRate: S.cache,
      runs: S.runs,
      governedActions: S.actions,
    },
    byOperator: S.byOperator.map((o) => ({
      operatorId: who(o.p),
      agents: o.agents,
      runs: o.runs,
      spend: money(o.spend, "mixed"),
      proven: money(o.proven, "mixed"),
      productiveRatio: o.ratio,
      budget: money(o.budget),
      budgetUsedRatio: o.used,
    })),
    byAgent: S.byAgent.map((a) => ({
      agentKey: a.k,
      runs: a.runs,
      spend: money(a.spend, "mixed"),
      proven: money(a.proven, "mixed"),
      perProvenRun: a.perProven === "—" ? null : money(a.perProven, "mixed"),
      trendPercent: trendPercent(a.trend),
    })),
    byModel: S.byModel.map((m) => ({
      model: m.m.replace(/ \(assistant\)$/, ""),
      assistant: m.m.endsWith("(assistant)"),
      calls: m.calls,
      spend: money(m.spend, "mixed"),
      cacheHitRate: m.cache,
    })),
    byTool: S.byTool.map((t) => ({
      tool: t.t === "(no tool call)" ? null : t.t,
      serverId: t.s === "model" ? null : t.s,
      calls: t.calls,
      runs: t.runs,
      spend: money(t.spend, "mixed"),
      perCall: t.perCall === null ? null : money(t.perCall, "mixed"),
      perRun: money(t.perRun, "mixed"),
      note: present(t.note),
    })),
    waste: {
      total: money(S.wasteTotal, "mixed"),
      share: S.wasteShare,
      runs: S.wasteRuns,
      causes: S.wasteByCause.map((c) => ({
        cause: pick(WASTE_CAUSE, c.c, "waste cause"),
        spend: money(c.spend, "mixed"),
        runs: c.runs,
        why: c.why,
      })),
      worstRuns: S.wasteRunsList.map((w) => ({
        runId: w.run,
        wasted: money(w.wasted, "mixed"),
        badges: w.badges.map((badge) => {
          const [label, tone] = cols(badge, 2, "badge");
          return {
            label,
            tone: pick(
              {
                critical: "critical",
                failed: "failed",
                denied: "denied",
                approval: "approval",
                allowed: "allowed",
                q: "neutral",
              } as const,
              tone,
              "badge tone",
            ),
          };
        }),
        what: w.what,
      })),
    },
    drills: Object.entries(raw.SPEND_DETAIL).map(([id, d]): SpendDrill => {
      const [kind, key] = cols(id.split(/:(.*)/s), 2, "drill id");
      const detail = d as Partial<Record<string, unknown>> & {
        cache: number;
        wasted: number;
        trend: string;
      };
      const num = (field: string): number | null => {
        const value = detail[field];
        return typeof value === "number" ? value : null;
      };
      const cash = (field: string): Money | null => {
        const value = detail[field];
        return typeof value === "number" ? money(value, "mixed") : null;
      };
      const rows = (field: string) =>
        detail[field] as
          | ReadonlyArray<ReadonlyArray<string | number>>
          | undefined;
      return {
        kind: pick(
          { operator: "operator", agent: "agent", tool: "tool" } as const,
          kind,
          "drill kind",
        ),
        id: kind === "operator" ? who(key) : key,
        cacheHitRate: detail.cache,
        wasted: money(detail.wasted, "mixed"),
        accepted: cash("accepted"),
        unproven: cash("unproven"),
        perRun: cash("perRun"),
        productiveRatio: num("ratio"),
        provenShare: num("provenShare"),
        resultTokens: num("resTok"),
        rerunRate: num("rerun"),
        retryRate: num("retry"),
        trend: detail.trend,
        modelCalls: num("modelCalls"),
        toolCalls: num("toolCalls"),
        agents: slices(rows("agents"), "agent"),
        operators: slices(rows("operators"), "operator"),
        tools: slices(rows("tools"), "tool"),
        models: slices(rows("models"), "model"),
      };
    }),
    findings: raw.FINDINGS.map(
      (f): Finding => ({
        id: f.id,
        kind: pick(FINDING_KIND, f.kind, "finding kind"),
        level: pick(
          {
            tool: "tool",
            agent: "agent",
            workspace: "workspace",
            operator: "operator",
          } as const,
          f.level,
          "finding level",
        ),
        subject: f.level === "operator" ? who(f.subject) : f.subject,
        saving: money(f.save, "gateway_observed"),
        window: f.window,
        why: f.why,
        fix: f.fix,
        scope: f.frames,
      }),
    ),
    evidence: Object.entries(raw.EVIDENCE).map(
      ([findingId, e]): FindingEvidence => {
        const repaired = EVIDENCE_AGENT_REPAIRS[e.who.agent] ?? e.who.agent;
        const evidenceBasis = pick(COST_BASIS, e.basis, "cost basis");
        return {
          findingId,
          confidence: pick(
            { high: "high", medium: "medium", low: "low" } as const,
            e.confidence,
            "confidence",
          ),
          trend: e.trend,
          basis: pick(
            {
              gateway_observed: "gateway_observed",
              client_attested: "client_attested",
              mixed: "mixed",
              estimated: "estimated",
            } as const,
            e.basis,
            "cost basis",
          ),
          signal: e.signal,
          measured: e.measured,
          baseline: e.baseline,
          counterfactual: e.counterfactual,
          method: e.method.map((row) => {
            const [step, text] = cols(row, 2, "evidence method");
            return { step, text };
          }),
          who: {
            agentKey: agentKeys.has(repaired) ? repaired : null,
            scope: agentKeys.has(repaired) ? repaired : e.who.agent,
            operatorId: who(e.who.operator),
            note: e.who.note,
          },
          runs: e.runs.map((row) => {
            const [id, task, at, cost, wasted, note] = cols(
              row,
              6,
              "cited run",
            );
            return {
              runId: runLink(id),
              task,
              at,
              cost: money(cost, evidenceBasis),
              wasted: money(wasted, "gateway_observed"),
              note,
            };
          }),
        };
      },
    ),
    fixes: raw.FINDINGS.map((f): FindingFix => {
      const fix = raw.FIX[f.kind as keyof typeof raw.FIX] as Partial<
        Record<string, unknown>
      > & { shape: string };
      if (fix.shape === "pr") {
        return {
          shape: "context_pr",
          findingId: f.id,
          lineage: String(fix.lineage),
          statement: String(fix.statement),
          enforcement: pick(
            { require: "require", forbid: "forbid" } as const,
            String(fix.effect),
            "fix enforcement",
          ),
          pullRequestRef: String(fix.pr),
          branch: String(fix.branch),
        };
      }
      const code = (sample: unknown) => {
        const s = sample as { lang: string; code: string };
        return { language: s.lang, code: stripMarkup(s.code) };
      };
      return {
        shape: "article",
        findingId: f.id,
        title: String(fix.title),
        why: String(fix.why),
        before: code(fix.before),
        after: code(fix.after),
        steps: [...(fix.steps as string[])],
        action: String(fix.action),
        done: String(fix.done),
      };
    }),
    reconciliation: {
      period: "2026-09",
      matchedRatio: S.matched,
      variance: money(S.variance, "mixed"),
      exceptions: S.exceptions,
      checkedAt: toInstant("09:12"),
    },
    budgets: S.budgets.map((b): Budget => {
      const [scope, id] = cols(b.scope.split(" · "), 2, "budget scope");
      return {
        scopeKind: pick(
          {
            organization: "org",
            workspace: "workspace",
            operator: "operator",
            agent: "agent",
          } as const,
          scope,
          "budget scope",
        ),
        scopeId: id,
        period: pick(
          {
            monthly: "monthly",
            daily: "daily",
            rolling: "rolling",
            "per run": "per_run",
          } as const,
          b.period,
          "budget period",
        ),
        limit: money(b.limit),
        spent: money(b.used, "mixed"),
        mode: pick(
          { hard: "hard", soft: "soft" } as const,
          b.mode,
          "budget mode",
        ),
      };
    }),
  };

  // ---- billing ----
  const B = raw.BILLING;
  const discount = req(
    /(\d+)% off usage for (\d+) months \(converted (\d{4})-(\d{2})-(\d{2})/.exec(
      B.discount,
    ),
    "billing discount",
  );
  const retention = req(
    /^(\d+) months included · ([\d.]+) GB · \$([\d.,]+)$/.exec(B.retention),
    "billing retention",
  );
  const overage = req(/× \$([\d.]+)$/.exec(B.tier2), "billing overage");
  const METER: ReadonlyArray<Meter["key"]> = [
    "sealed_runs",
    "governed_actions",
    "retained_evidence_gb",
    "halted_before_model_call",
    "assistant_runs",
    "witness_runs",
  ];
  const billing: Seed["billing"] = {
    plan: {
      plan: pick(
        { Team: "team", Free: "free", Enterprise: "enterprise" } as const,
        B.plan,
        "plan",
      ),
      status: "active",
      nextInvoiceOn: B.next,
      discount: {
        description: req(B.discount.split(" — ")[0], "discount"),
        percentOff: Number(discount[1]),
        until: `${String(Number(discount[3]) + Math.floor(Number(discount[2]) / 12))}-${req(discount[4], "discount capture 4")}-${req(discount[5], "discount capture 5")}`,
      },
    },
    allowance: {
      includedRuns: B.runsIncluded,
      runsUsed: B.runsUsed,
      billableRuns: B.billable,
      overagePerRun: money(req(overage[1], "overage capture 1")),
      usage: money(B.amount),
      discount: money(B.discountAmount),
      total: money(B.total),
      retention: {
        includedMonths: Number(req(retention[1], "retention capture 1")),
        retainedGb: Number(req(retention[2], "retention capture 2")),
        charge: money(req(retention[3], "retention capture 3")),
      },
    },
    meters: B.meters.map((m, index) => ({
      key: req(METER[index], "meter"),
      value: Number(m.v.replace(/[^\d.]/g, "")),
      priced: m.note === "the billable unit",
    })),
    invoices: B.invoices.map((i) => {
      const date = new Date(`${i.p} 1 UTC`);
      return {
        number: i.n,
        period: `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
        runs: i.runs,
        amount: money(i.amt),
        status: pick(
          { paid: "paid", open: "open", void: "void" } as const,
          i.st,
          "invoice status",
        ),
        issuedOn: i.d,
      };
    }),
  };

  // ---- audit ----
  const actor = (name: string): AuditEvent["actor"] =>
    agentKeys.has(name)
      ? { kind: "agent", agentKey: name }
      : isPersonName(name)
        ? { kind: "person", personId: who(name) }
        : { kind: "system", name };
  const INCIDENT_KIND = {
    "mandate.exception": "mandate_exception",
    assurance_gap: "assurance_gap",
    taint_raised: "taint_raised",
    witness_tampered: "witness_tampered",
    chain_break: "chain_break",
    hooks_removed: "hooks_removed",
    credential_probe: "credential_probe",
  } as const;
  const facts = (
    rows: ReadonlyArray<ReadonlyArray<string | number>>,
  ): ReceiptFact[] =>
    rows.map(([label, value, mono]) => ({
      key: slugKey(String(label)),
      value: repairText(String(value)),
      mono: mono === 1,
    }));
  const audit: Seed["audit"] = {
    events: raw.AUDIT.map((e) => ({
      at: toInstant(e.t),
      kind: e.ev,
      actor: actor(e.who),
      summary: e.what,
      severity: pick(SEVERITY, e.sev, "severity"),
      ref: e.ref,
    })),
    incidents: raw.INCIDENTS.map(
      (i): Incident => ({
        id: i.id,
        severity: pick(SEVERITY, i.sev, "severity"),
        kind: pick(INCIDENT_KIND, i.kind, "incident kind"),
        title: i.title,
        at: toInstant(i.at),
        detectedBy: i.by,
        agentKey: [...agentKeys].find((key) => i.scope.startsWith(key)) ?? null,
        runIds: [...i.scope.matchAll(/run_[A-Za-z0-9]+/g)].flatMap((m) => {
          const link = runLink(m[0]);
          return link ? [link] : [];
        }),
        scope: repairText(i.scope),
        detail: i.detail,
        resolution: repairText(i.resolution),
        status: pick(
          { open: "open", resolved: "resolved" } as const,
          i.status,
          "incident status",
        ),
        ownerId: i.owner ? who(i.owner) : null,
        dueOn: i.due ?? null,
        closedAt: present(i.closedAt) ? toInstant(i.closedAt) : null,
        closedBy: present(i.closedBy),
      }),
    ),
    receipts: raw.RECEIPTS.map(
      (r): Receipt => ({
        id: r.id,
        at: toInstant(r.at),
        agent: r.agent,
        operatorId: who(r.operator),
        tool: r.tool,
        decision: pick(
          {
            allow: "allow",
            approve: "approve",
            deny: "deny",
            observed: "observed",
          } as const,
          r.decision,
          "receipt decision",
        ),
        tier: pick(
          {
            gateway: "gateway",
            harness: "harness",
            observe: "observe",
          } as const,
          r.tier,
          "tier",
        ),
        externalEffect: r.effect,
        amount: r.amount === "—" ? null : money(r.amount),
        workspaceSlug: r.ws,
        runId: runLink(r.runId),
        who: facts(r.who),
        what: facts(r.what),
        authority: facts(r.authority),
        credential: facts(r.credential),
        effect: facts(r.effectRows),
        integrity: facts(r.integrity),
      }),
    ),
    holds: raw.HOLDS.map((h) => ({
      id: h.id,
      matter: h.matter,
      scope: h.scope,
      placedById: who(h.by),
      placedAt: toInstant(h.placed),
      releasedAt: present(h.released) ? toInstant(h.released) : null,
      status: pick(
        { active: "active", released: "released" } as const,
        h.st,
        "hold status",
      ),
      note: h.note,
    })),
    exports: raw.EXPORTS.map((x) => {
      const [from, to] = cols(x.range.split(" → "), 2, "export range");
      return {
        id: x.id,
        description: x.what,
        from,
        to,
        contents: x.runs,
        size: x.size,
        createdAt: toInstant(x.at),
        createdById: who(x.by),
        status: pick(
          { ready: "ready", building: "building" } as const,
          x.st,
          "export status",
        ),
        signature: x.sig === "pending" ? null : x.sig,
        keys: x.keys,
      };
    }),
    keys: raw.KEYS.map((k) => ({
      id: k.id,
      purpose: k.name.startsWith("KEK")
        ? ("kek" as const)
        : k.name.startsWith("Run attestation")
          ? ("attestation" as const)
          : ("device" as const),
      name: k.name,
      algorithm: k.alg,
      generation: Number(k.gen),
      validFrom: /\d{2}:\d{2}/.test(k.from) ? toInstant(k.from) : k.from,
      validTo: /\d{2}:\d{2}/.test(k.to) ? toInstant(k.to) : k.to,
      status: pick(
        {
          active: "active",
          retiring: "retiring",
          retired: "retired",
          expired: "expired",
        } as const,
        k.st,
        "key status",
      ),
      covers: k.covers,
    })),
    erasure: raw.ERASURE.map((e) => ({
      id: e.id,
      subject: e.subject,
      requestedAt: toInstant(e.at),
      requestedById: who(e.by),
      status: pick(
        {
          "keys destroyed": "keys_destroyed",
          "blocked by hold": "blocked_by_hold",
          pending: "pending",
        } as const,
        e.st,
        "erasure status",
      ),
      effectiveAt: e.st === "keys destroyed" ? toInstant(e.when) : null,
      dueAt: e.when.startsWith("due ") ? toInstant(e.when.slice(4)) : null,
      scope: e.scope,
      holdId: /hld_[A-Za-z0-9]+/.exec(e.note)?.[0] ?? null,
      note: present(e.note),
    })),
    retention: raw.RETENTION_TIERS.map((row) => {
      const [label, store, contents, retentionText, volume] = cols(
        row,
        5,
        "retention tier",
      );
      return {
        tier: pick(
          {
            Ledger: "ledger",
            Frames: "frames",
            "Bodies and segments": "bodies",
            "Control-plane audit": "control_plane_audit",
          } as const,
          label,
          "retention tier",
        ),
        store,
        contents,
        retention: retentionText,
        volume,
      };
    }),
    assuranceHistory: raw.ASSURANCE_HISTORY.map((a) => ({
      suiteVersion: a.rel.replace(/^suite /, ""),
      ranAt: toInstant(a.ran),
      cases: a.cases,
      passed: a.pass,
      failed: a.fail,
      notApplicable: a.na,
      against: a.against,
      note: present(a.note),
    })),
  };

  // ---- notifications ----
  const TONE = {
    approval: "approval",
    failed: "failed",
    allowed: "allowed",
    gold: "steering",
    critical: "critical",
  } as const;
  /** W4: the two notifications that describe seeded events name them. */
  const NOTIFICATION_REPAIRS: Readonly<
    Record<string, Pick<Notification, "title" | "body" | "runId" | "ref">>
  > = {
    "approval.requested": {
      title: "Approval waiting · github__create_release@2",
      body: "acme.core.release-manager on run_01K5RS7M2E8FJ3QW wants to create the v4.11.0 draft release on acme/platform. Rule rg_0093. Expires in 10 minutes.",
      runId: "run_01K5RS7M2E8FJ3QW",
      ref: "apr_01K5RS3K7",
    },
    "run.proven": {
      title: "Run proven · run_01K5RQ4B9C7XTN2P",
      body: "Witness wit_01K5RQ8M4 flipped: failing on main at a4c91e2, passing on refs/pull/482/head at f70b3d9. Oracle test_flip, disclosure grain L0.",
      runId: "run_01K5RQ4B9C7XTN2P",
      ref: "wit_01K5RQ8M4",
    },
  };
  const notifications: Notification[] = raw.NOTIFS.map((n, index) => {
    const repair = NOTIFICATION_REPAIRS[n.kind];
    return {
      id: `ntf_0${String(index + 1)}`,
      kind: n.kind,
      tone: pick(TONE, n.tone, "notification tone"),
      unread: n.unread,
      at: toInstant(n.t),
      title: repair?.title ?? n.title,
      body: repair?.body ?? n.body,
      runId: repair?.runId ?? null,
      ref: repair?.ref ?? null,
    };
  });

  return {
    now: FIXTURE_NOW,
    organization,
    workspaces,
    people,
    members,
    invitations,
    apiKeys,
    dataPlanes,
    modelFunding,
    roles,
    permissionGroups,
    agents,
    toolbelts,
    definitions,
    scores,
    runs,
    frames,
    transcripts,
    runGraphs,
    contextWindows,
    proofs,
    approvals,
    approvalClocks,
    mandates,
    mandateLedger,
    servers,
    toolVersions,
    connections,
    observedSchemas,
    killSwitches,
    autoApprovalRules,
    assurance,
    policyVersions,
    policySimulations,
    classes,
    sources,
    repositories,
    ontologyVersions,
    embeddingIndexes,
    records,
    proposals,
    recordEffects,
    retirementCandidates,
    spend,
    billing,
    audit,
    notifications,
  };
}

function contextKind(kind: string) {
  return pick(
    {
      fact: "fact",
      doc: "doc",
      symbol: "symbol",
      episode: "episode",
      memory: "memory",
    } as const,
    kind,
    "context frame kind",
  );
}

type RawTranscriptEntry =
  RawMockup["TRANSCRIPTS"]["run_01K5RS7M2E8FJ3QW"][number];

function transcriptEntry(
  e: RawTranscriptEntry,
  who: (name: string) => string,
): TranscriptEntry {
  const base = { offsetSeconds: e.t, frameSeq: e.fr ?? null };
  switch (e.kind) {
    case "prompt":
      return {
        ...base,
        kind: "prompt",
        body: req(e.body, "transcript body"),
        taskRef: e.meta?.task ?? null,
        byPersonId: who(req(e.meta?.by, "transcript by")),
      };
    case "context_recall":
      return {
        ...base,
        kind: "context_recall",
        contextFrames: req(e.meta?.frames, "transcript frames"),
        tokens: req(e.meta?.tok, "transcript tok"),
        candidatesScored: req(e.meta?.scored, "transcript scored"),
        durationMs: req(e.meta?.ms, "transcript ms"),
      };
    case "reasoning":
    case "text":
      return { ...base, kind: e.kind, body: req(e.body, "transcript body") };
    case "usage":
      return {
        ...base,
        kind: "usage",
        model: req(e.meta?.model, "transcript model"),
        tokensIn: req(e.meta?.tin, "transcript tin"),
        cacheRead: req(e.meta?.cache, "transcript cache"),
        tokensOut: req(e.meta?.tout, "transcript tout"),
        cost: money(req(e.meta?.cost, "transcript cost"), "gateway_observed"),
        providerRequestId: req(e.meta?.req, "transcript req"),
      };
    case "tool":
      return {
        ...base,
        kind: "tool",
        tool: req(e.title, "transcript title"),
        toolClass: pick(
          {
            repo: "repo",
            inspect: "inspect",
            mutate: "mutate",
            verify: "verify",
          } as const,
          req(e.cls, "transcript cls"),
          "tool class",
        ),
        argument: req(e.arg, "transcript arg"),
        rawInput: req(e.raw, "transcript raw"),
        decision: e.gov
          ? {
              outcome: pick(
                { allow: "allow", approve: "approve", deny: "deny" } as const,
                e.gov.o,
                "tool decision",
              ),
              rule: e.gov.rule,
              frameSeq: e.gov.fr,
            }
          : null,
        result: e.res
          ? {
              durationMs: e.res.ms,
              isError: e.res.err ?? false,
              body: e.res.body,
            }
          : null,
        diff: e.diff
          ? { path: e.diff.path, before: e.diff.before, after: e.diff.after }
          : null,
        parked: e.parked
          ? { approvalId: e.parked.ap, frameSeq: e.parked.fr }
          : null,
      };
    case "steer":
      return {
        ...base,
        kind: "steer",
        body: req(e.body, "transcript body"),
        byPersonId: who(req(e.meta?.by, "transcript by")),
        tokens: req(e.meta?.tok, "transcript tok"),
      };
    default:
      throw new MappingError("transcript entry kind", e.kind);
  }
}

/** The mockup's `agentTomlSeed(a)`: the definition file an agent is registered from. */
function agentToml(slug: string, a: RawMockup["AGENTS"][number]): string {
  const instructions =
    slug === "release-manager"
      ? "You prepare releases for this repository. Read the changelog\nconventions in .oxagen/rules before writing notes. Open a pull\nrequest; a person merges it."
      : `You are ${a.name}. ${a.desc}\nWork inside the toolbelt you were given; when a step needs\nauthority you do not hold, stop and say so.`;
  return [
    `# .oxagen/agents/${slug}.toml`,
    'schema = "agent-definition/v0.1"',
    `slug = "${slug}"`,
    `name = "${a.name}"`,
    `description = "${a.desc}"`,
    `model_tier = "${a.model}"`,
    'tools = ["github__*", "linear__get_issue", "search_graph", "recall_context"]',
    'deny_tools = ["github__merge_pull_request@*", "github__delete_*@*"]',
    'side_effects = ["read", "write"]',
    `budget = { per_run_micros = ${toMicros(a.budget)} }`,
    "",
    "[instructions]",
    'body = """',
    instructions,
    '"""',
    "",
    `[harness.${a.harness}]`,
    'color = "blue"',
    "",
  ].join("\n");
}
