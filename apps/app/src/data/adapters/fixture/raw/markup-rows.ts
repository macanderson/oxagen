// Rows the mockup hard-codes in its markup rather than in a collection (plan
// W5), hand-ported from mc.html @ mc-baseline-w1 in the mockup's own words.
// Like mc-baseline-w1.json, this file is read only by ../mapping.ts.

/** mc.html `REGISTRY_VERSIONS` and `FULL_BELT_LIMIT` (the toolbelt tab). */
export const REGISTRY = { versions: 3182, fullBeltLimit: 40 } as const;

/** pMandate(): "The ledger" table. */
export const MANDATE_LEDGER_ROWS = [
  {
    mandate: "mnd_7K2ETQ4",
    when: "08:40:19",
    call: "stripe__create_payment@4",
    amount: "2,450.00",
    state: "reserved",
    external: null,
    note: "awaiting approval",
    receipt: null,
  },
  {
    mandate: "mnd_7K2ETQ4",
    when: "2026-09-04 10:22:41.908Z",
    call: "stripe__create_payment@4",
    amount: "884.60",
    state: "settled",
    external: "pi_3QaL8f2Xk",
    note: null,
    receipt: "rcp_01K4X8M2E",
  },
  {
    mandate: "mnd_7K2ETQ4",
    when: "2026-09-02",
    call: "aws_billing__purchase_savings_plan@2",
    amount: "400.00",
    state: "settled",
    external: "sp-0a4f91c",
    note: null,
    // "rcp_01K4W2…" is truncated in the markup and has no RECEIPTS row.
    receipt: null,
  },
  {
    mandate: "mnd_7K2ETQ4",
    when: "2026-09-01",
    call: "stripe__create_payment@4",
    amount: "0.00",
    state: "released",
    external: null,
    note: "dispatch failed · released",
    receipt: null,
  },
] as const;

/** pSteering() effect tab. */
export const STEERING_EFFECT_ROWS = [
  {
    lineage: "ctx.release.notes-format",
    kind: "rule",
    rendered: 212,
    cited: 188,
    violated: 3,
    before: 0.41,
    after: 0.58,
    verdict: "keep",
  },
  {
    lineage: "ctx.release.never-merge",
    kind: "constraint",
    rendered: 212,
    cited: 212,
    violated: 0,
    before: null,
    after: null,
    verdict: "keep",
  },
  {
    lineage: "ctx.mobile.no-codegen",
    kind: "constraint",
    rendered: 84,
    cited: 71,
    violated: 1,
    before: 0.3,
    after: 0.33,
    verdict: "keep",
  },
  {
    lineage: "ctx.platform.changelog-once",
    kind: "fact",
    rendered: 212,
    cited: 96,
    violated: 0,
    before: 0.44,
    after: 0.45,
    verdict: "watch",
  },
] as const;

/** pSteering() retirement tab. */
export const RETIREMENT_ROWS = [
  {
    lineage: "ctx.platform.retry-budget",
    kind: "rule",
    published: "2026-03-11",
    rendered: 0,
    cited: 0,
    why: "Superseded by the hard budget on the agent definition. Nothing has rendered it in 90 days.",
    archived: "2026-09-01",
  },
] as const;

/** pOrganization() funding tab. */
export const FUNDING = {
  source: "platform",
  cap: "2,000.00",
  used: "1,082.45",
  routes: [
    {
      tier: "complex",
      route: "z-ai/glm-latest",
      resolves: "GLM 5.3 · 1.3M context",
      fallback: "z-ai/glm-4.7",
    },
    {
      tier: "light",
      route: "z-ai/glm-flash-latest",
      resolves: "GLM 5.3 Flash",
      fallback: null,
    },
    {
      tier: "embed",
      route: "Voyage AI, direct",
      resolves: "voyage-4, voyage-code-3, voyage-context-3",
      fallback: null,
    },
    {
      tier: "rerank",
      route: "Voyage AI",
      resolves: "rerank-2.5",
      fallback: null,
    },
  ],
} as const;

/** pOrganization() plane tab. */
export const DATA_PLANE_ROWS = [
  {
    store: "postgres",
    isolation: "partitioned by org_id · row-level policies enforced",
  },
  { store: "neo4j", isolation: "one database per organization · acme" },
  {
    store: "objects",
    isolation:
      "object lock, compliance mode · per-organization key-encryption key",
  },
] as const;

// ---- Register an agent and the onboarding gate -------------------------------

/**
 * The Register Agent gate's script (`REG_TOKEN`, `REG_HOST`, `osFile`,
 * `regLines()` for the Claude Code tab). `{harness}`, `{agentKey}` and
 * `{operator}` in a frame body are filled in for the agent being wrapped.
 */
export const REGISTER_GATE = {
  token: "oxe_1time_7QK4M2NV9XR3T8ZP",
  tokenExpiresInMinutes: 30,
  host: "mbell-mbp.local",
  sdkCredentialMasked: "oxa_live_••••••••••••3f7a",
  builds: {
    macos: {
      file: "Oxagen-Agent-2.4.0.pkg",
      size: "14.2 MB",
      signature: "notarized · Developer ID",
      digest: "sha256:3f9c71d2…b40a",
    },
    windows: {
      file: "Oxagen-Agent-2.4.0.msi",
      size: "16.8 MB",
      signature: "signed · EV certificate",
      digest: "sha256:7a21ce55…19f3",
    },
    linux: {
      file: "oxagen-agent_2.4.0_amd64.deb",
      size: "12.9 MB",
      signature: "deb, rpm and curl script",
      digest: "sha256:c40b8e19…62dd",
    },
  },
  tier: "gateway",
  paceMs: 780,
  log: [
    { at: "14:01:48", text: "host enrolled · device key ed25519:7f3a…c19e" },
    {
      at: "14:01:52",
      text: "collector oxagend running · pid 4412 · launchd com.oxagen.oxagend",
    },
    {
      at: "14:01:55",
      text: "hooks written · ~/.claude/settings.json · 7 events",
    },
    {
      at: "14:01:58",
      text: "ANTHROPIC_BASE_URL set · https://proxy.oxagen.com/v1",
    },
    { at: "14:02:01", text: "model proxy reachable · 41 ms · tier gateway" },
    { at: "14:02:04", text: "MCP endpoint registered · 0 tools granted yet" },
    {
      at: "14:02:11",
      text: "frame received · seq 0 · agent.start",
      firstFrame: true,
    },
  ],
  frames: [
    {
      seq: "0",
      at: "14:02:11.402",
      kind: "agent.start",
      body: "harness={harness} · host=mbell-mbp.local · attested=device-key",
    },
    {
      seq: "1",
      at: "14:02:11.418",
      kind: "context.assembled",
      body: "agent={agentKey} · operator={operator} · tier=gateway · steering=none published",
    },
  ],
} as const;

/** The gate's "Repository detected" card: the installer's working directory remote. */
export const DETECTED_REPOSITORY = {
  fullName: "acme/platform",
  remote: "git@github.com:acme/platform.git",
  directory: "~/src/platform",
  branch: "main",
  provisionalDays: 14,
} as const;

/**
 * Not in the mockup: /invite/[token] has no mockup screen, so these are one
 * invitation per state the page renders (pending for the fixture operator,
 * already accepted, and pending for another address). Tokens are the public ids.
 */
export const INVITE_LINKS = [
  {
    token: "invi_acme_pending",
    invitee: "operator",
    role: "member",
    status: "pending",
    inviter: "priya",
    invitedAt: "2026-09-11T09:00:00.000Z",
    expiresAt: "2099-09-18T09:00:00.000Z",
  },
  {
    token: "invi_acme_accepted",
    invitee: "operator",
    role: "member",
    status: "accepted",
    inviter: "priya",
    invitedAt: "2026-09-09T09:00:00.000Z",
    expiresAt: "2026-09-16T09:00:00.000Z",
  },
  {
    token: "invi_acme_other",
    invitee: "dana.okafor@acme.example",
    role: "compliance",
    status: "pending",
    inviter: "priya",
    invitedAt: "2026-09-11T09:00:00.000Z",
    expiresAt: "2099-09-18T09:00:00.000Z",
  },
] as const;

// ---- Shell -------------------------------------------------------------------

/** The assistant flyout's engine line (`glm-flash · ready`) and its down state. */
export const ASSISTANT_ENGINE = {
  up: { status: "up", model: "glm-flash", version: "0.31.4" },
  down: {
    status: "down",
    httpStatus: 503,
    version: "0.31.4",
    lastHealthyAt: "2026-09-12T09:02:11Z",
  },
} as const;

/** The Account dialog's panels for the fixture operator (identity comes from the session). */
export const ACCOUNT_DIALOG = {
  emailVerifiedAt: "2026-08-22T09:00:00Z",
  principalId: "prn_01K3F8QB7R",
  managedBy: "Okta",
  roles: [
    { scope: "acme", role: "org.member" },
    { scope: "core-platform", role: "workspace.owner" },
  ],
  preferences: { locale: "en-US", displayCurrency: "USD", timeZone: "UTC" },
  security: {
    signInProvider: "Okta SSO",
    passwordSignIn: false,
    factors: [
      {
        kind: "totp",
        enrolledAt: "2026-08-22T09:05:00Z",
        recoveryCodesRemaining: 8,
      },
      { kind: "passkey", enrolledAt: null, recoveryCodesRemaining: null },
    ],
    sessions: [
      {
        id: "ses_mbp_chrome",
        device: "MacBook Pro · Chrome 141",
        location: "San Francisco",
        lastActiveAt: "2026-09-12T15:47:00Z",
        current: true,
      },
      {
        id: "ses_iphone_safari",
        device: "iPhone 17 · Safari",
        location: "San Francisco",
        lastActiveAt: "2026-09-11T08:12:00Z",
        current: false,
      },
      {
        id: "ses_cli_mbp01",
        device: "oxagen CLI · mbp-01",
        location: "San Francisco",
        lastActiveAt: "2026-08-22T17:40:00Z",
        current: false,
      },
    ],
  },
  privacy: { retentionYears: 7, legalHolds: 0 },
} as const;
