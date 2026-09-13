// The shell's fixture reads: the demo record (Acme Robotics / core-platform /
// Marcus Bell) from mc.html @ mc-baseline-w1 (ORG, WS, NOTIFS, CMDS, the Account
// dialog), mapped to spec vocabulary. Dev, Storybook and e2e only: `shellSource`
// imports this module dynamically and only in fixture mode.
//
// Every value is parsed through its contract, so the fixture cannot drift from
// the shape the live adapter must return.
//
// PROMOTE: src/data/adapters/fixture/shell.ts (lane L1), seeded from L1's seed.
import { z } from "zod";
import { notBacked, readError, readOk, type Read } from "@/data/not-backed";
import { FIXTURE_USER } from "@/server/fixture-session";
import {
  AccountView,
  AssistantEngine,
  CommandRun,
  NavCounts,
  NotificationFeed,
  ShellContext,
  type ShellWorkspace,
} from "../contracts";
import type { ShellSwitches } from "../fixture-switches";
import type { ShellQuery, ShellReadPort } from "../port";

const ACME = {
  slug: "acme",
  name: "Acme Robotics",
  plan: "Team",
  dataPlane: "shared",
  region: "us-east-1",
} as const;

const WORKSPACES: ShellWorkspace[] = [
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
    mainRepo: "acme/finops-agents",
    productionBranch: "main",
    agentCount: 12,
  },
];

const COUNTS: Record<string, NavCounts> = {
  "core-platform": {
    pendingApprovals: 2,
    agents: 38,
    openProposals: 3,
    openIncidents: 1,
  },
  finops: {
    pendingApprovals: 1,
    agents: 12,
    openProposals: 0,
    openIncidents: 1,
  },
};

const NOTIFICATIONS = NotificationFeed.parse({
  items: [
    {
      id: "ntf_01K5ZB4T8P",
      kind: "approval.requested",
      severity: "info",
      unread: true,
      at: "2026-09-12T15:44:00Z",
      runId: "run_01K5ZB4T8P",
      title: "Approval waiting · github__merge_pull_request@3",
      body: "acme.core.release-manager on run_01K5ZB4T8P wants to merge acme/platform#1893 into main. Rule merge.requires_approval. Expires 15:54.",
    },
    {
      id: "ntf_01K5ZA0J2M",
      kind: "budget.breached",
      severity: "critical",
      unread: true,
      at: "2026-09-12T15:21:00Z",
      runId: "run_01K5ZA0J2M",
      title: "Hard budget reached · acme.core.docs-writer",
      body: "$0.80 per run reached at turn 3 of run_01K5ZA0J2M. The run was paused at the model proxy before the call.",
    },
    {
      id: "ntf_01K5YQ9T2B",
      kind: "approval.resolved",
      severity: "attention",
      unread: true,
      at: "2026-09-12T14:13:00Z",
      runId: null,
      title: "Approval expired · stripe__create_payment@4",
      body: "No approver resolved apr_01K5YQ9T2B within 10 minutes. $184.20 USD to vendor:aws was never dispatched; mandate mnd_4471 released the reservation.",
    },
    {
      id: "ntf_01K5YX2D6R",
      kind: "run.proven",
      severity: "success",
      unread: false,
      at: "2026-09-12T15:09:00Z",
      runId: "run_01K5YX2D6R",
      title: "Run proven · run_01K5YX2D6R",
      body: "Witness wit_01K5YX51 flipped: failing on main at 9c41ab0, passing on refs/pull/1887/head at 3d8f77e. Oracle test_flip, disclosure grain L0.",
    },
    {
      id: "ntf_01K5YW1892",
      kind: "context_pr.opened",
      severity: "info",
      unread: false,
      at: "2026-09-12T13:02:00Z",
      runId: null,
      title: "Context PR opened · acme/platform#1892",
      body: "The promoter proposed a rule on lineage lin_7fa2: “Do not re-read CHANGELOG.md after the first read in a run.” Supported by 14 runs across 3 agents.",
    },
    {
      id: "ntf_01K5YV3D8F",
      kind: "repository.indexed",
      severity: "success",
      unread: false,
      at: "2026-09-12T12:40:00Z",
      runId: null,
      title: "Code graph current · acme/platform",
      body: "Push 3d8f77e to main indexed in 41 s. 18 files re-parsed, 62 symbols versioned, 3 data-layer edges raised to confirmed.",
    },
    {
      id: "ntf_01K5YR9F21",
      kind: "reconciliation.exception",
      severity: "attention",
      unread: false,
      at: "2026-09-12T09:12:00Z",
      runId: null,
      title: "Reconciliation variance · anthropic key pk_9f21",
      body: "2026-09-10 key-day variance $0.83 above the one-cent threshold. 4 client-attested frames carry no provider request id and match only at level 2.",
    },
    {
      id: "ntf_01K5QK7S3W",
      kind: "kill_switch.flipped",
      severity: "critical",
      unread: false,
      at: "2026-09-09T11:30:00Z",
      runId: null,
      title: "Kill switch flipped · tool version",
      body: "Priya Natarajan disabled slack__post_message@7 across acme after a schema regression. 2 runs saw the deny at their next call boundary.",
    },
  ],
});

const RUNS = CommandRun.array().parse([
  {
    id: "run_01K5RS7M2E8FJ3QW",
    workspace: "core-platform",
    agentKey: "acme.core.release-manager",
  },
  {
    id: "run_01K5RQ4B9C7XTN2P",
    workspace: "core-platform",
    agentKey: "acme.core.stella-ci",
  },
  {
    id: "run_01K4QJ9E4T6YUI1O",
    workspace: "core-platform",
    agentKey: "acme.core.stella-ci",
  },
]);

const ACCOUNT = AccountView.parse({
  profile: {
    name: FIXTURE_USER.name,
    email: FIXTURE_USER.email,
    emailVerifiedAt: "2026-08-22T09:00:00Z",
    principalId: "prn_01K3F8QB7R",
    managedBy: "Okta",
    roles: [
      { scope: "acme", role: "org.member" },
      { scope: "core-platform", role: "workspace.owner" },
    ],
  },
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
});

function isAcme(q: ShellQuery): boolean {
  return q.org === ACME.slug && q.userId === FIXTURE_USER.id;
}

const orgNotFound = () => readError("organization_not_found", 404);

export function fixtureShell(switches: ShellSwitches): ShellReadPort {
  return {
    context(q) {
      if (!isAcme(q)) return Promise.resolve(orgNotFound());
      return Promise.resolve(
        readOk(
          ShellContext.parse({
            viewer: FIXTURE_USER,
            org: ACME,
            orgs: [{ slug: ACME.slug, name: ACME.name, plan: ACME.plan }],
            workspaces: WORKSPACES,
          }),
        ),
      );
    },
    navCounts(q) {
      if (!isAcme(q)) return Promise.resolve(orgNotFound());
      return Promise.resolve(
        readOk(z.record(z.string(), NavCounts).parse(COUNTS)),
      );
    },
    notifications(q) {
      if (!isAcme(q)) return Promise.resolve(orgNotFound());
      const result: Read<NotificationFeed> =
        switches.notifications === "empty"
          ? readOk({ items: [] })
          : switches.notifications === "error"
            ? readError("notification_store_unavailable", 503)
            : switches.notifications === "not_backed"
              ? notBacked("M1", "G15")
              : readOk(NOTIFICATIONS);
      return Promise.resolve(result);
    },
    assistantEngine(q) {
      if (!isAcme(q)) return Promise.resolve(orgNotFound());
      return Promise.resolve(
        readOk(
          AssistantEngine.parse(
            switches.engine === "down"
              ? {
                  status: "down",
                  httpStatus: 503,
                  version: "0.31.4",
                  lastHealthyAt: "2026-09-12T09:02:11Z",
                }
              : { status: "up", model: "glm-flash", version: "0.31.4" },
          ),
        ),
      );
    },
    recentRuns(q) {
      if (!isAcme(q)) return Promise.resolve(orgNotFound());
      return Promise.resolve(readOk(RUNS));
    },
    account(q) {
      if (q.userId !== FIXTURE_USER.id)
        return Promise.resolve(readError("account_not_found", 404));
      return Promise.resolve(readOk(ACCOUNT));
    },
  };
}
