// Typed shell view-model values for the shell's unit and component tests
// (ARCHITECTURE.md §5): one organization with two workspaces, a viewer who
// belongs to the first, and every read in its `ok` state. Tests override the
// reads they exercise. Importable from tests only (import graph, knip).
import type {
  AccountView,
  AssistantEngine,
  CommandRun,
  NavCounts,
  Notification,
  ShellContext,
} from "@/data/contracts/shell";
import { readOk } from "@/data/not-backed";
import type { ShellData } from "./shell-data";

export const SHELL_VIEWER = {
  id: "usr_marcusbell",
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
} as const;

export const SHELL_ORG_ID = "7a000000-0000-4000-8000-0000000000a1";

const context: ShellContext = {
  viewer: SHELL_VIEWER,
  org: {
    slug: "acme",
    name: "Acme Robotics",
    plan: "Scale",
    dataPlane: "shared",
    region: "us-east-1",
  },
  orgs: [{ slug: "acme", name: "Acme Robotics", plan: "Scale" }],
  workspaces: [
    {
      slug: "core-platform",
      name: "Core platform",
      mainRepo: "acme/platform",
      productionBranch: "main",
      agentCount: 38,
    },
    {
      slug: "finops",
      name: "FinOps",
      mainRepo: null,
      productionBranch: null,
      agentCount: 4,
    },
  ],
};

const counts: Record<string, NavCounts> = {
  "core-platform": {
    pendingApprovals: 1,
    agents: 38,
    openProposals: 2,
    openIncidents: 0,
  },
  finops: {
    pendingApprovals: 0,
    agents: 4,
    openProposals: 0,
    openIncidents: 0,
  },
};

const at = (minutesAgo: number): string =>
  new Date(Date.UTC(2026, 8, 12, 9, 30 - minutesAgo)).toISOString();

/** Eight notifications, newest first, three of them unread. */
const notifications: Notification[] = [
  {
    id: "ntf_01",
    kind: "approval.requested",
    severity: "attention",
    title: "Approval waiting",
    body: "release-manager wants to open a pull request.",
    unread: true,
    at: at(1),
    runId: "run_01K5RS7M2E8FJ3QW",
    ref: "apr_01",
  },
  {
    id: "ntf_02",
    kind: "run.proven",
    severity: "success",
    title: "Run proven",
    body: null,
    unread: true,
    at: at(2),
    runId: "run_01K5RQ4B9C7XTN2P",
    ref: null,
  },
  {
    id: "ntf_03",
    kind: "member",
    severity: null,
    title: "Priya Raman joined",
    body: null,
    unread: true,
    at: at(3),
    runId: null,
    ref: null,
  },
  ...[4, 5, 6, 7, 8].map(
    (n): Notification => ({
      id: `ntf_0${String(n)}`,
      kind: "system",
      severity: "info",
      title: `Notice ${String(n)}`,
      body: null,
      unread: false,
      at: at(n),
      runId: null,
      ref: null,
    }),
  ),
];

export const ENGINE_UP: AssistantEngine = {
  status: "up",
  model: "glm-flash",
  version: "0.31.4",
};

export const ENGINE_DOWN: AssistantEngine = {
  status: "down",
  httpStatus: 503,
  version: "0.31.4",
  lastHealthyAt: "2026-09-12T09:02:00.000Z",
};

const runs: CommandRun[] = [
  {
    id: "run_01K5RS7M2E8FJ3QW",
    workspace: "core-platform",
    agentKey: "acme.core.release-manager",
  },
  {
    id: "run_01K5RQ4B9C7XTN2P",
    workspace: "core-platform",
    agentKey: "acme.core.perf-watch",
  },
];

const account: AccountView = {
  profile: {
    name: SHELL_VIEWER.name,
    email: SHELL_VIEWER.email,
    emailVerifiedAt: "2026-09-01T10:00:00.000Z",
    principalId: "prn_01K5RSMARCUS",
    managedBy: null,
    roles: [{ scope: "core-platform", role: "workspace.owner" }],
  },
  preferences: { locale: "en", displayCurrency: "USD", timeZone: "UTC" },
  security: {
    signInProvider: null,
    passwordSignIn: true,
    factors: [
      {
        kind: "totp",
        enrolledAt: "2026-09-02T10:00:00.000Z",
        recoveryCodesRemaining: 8,
      },
    ],
    sessions: [
      {
        id: "ses_current",
        device: "Chrome on macOS",
        location: "Boston, US",
        lastActiveAt: at(0),
        current: true,
      },
    ],
  },
  privacy: { retentionYears: 7, legalHolds: 0 },
};

/** Every shell read in its `ok` state, with any field overridden. */
export function shellData(overrides: Partial<ShellData> = {}): ShellData {
  return {
    org: "acme",
    context: readOk(context),
    counts: readOk(counts),
    notifications: readOk({ items: notifications }),
    engine: readOk(ENGINE_UP),
    runs,
    account: readOk(account),
    ...overrides,
  };
}
