// Typed shell values for the shell's unit and component tests (ARCHITECTURE.md
// §5): one organization, the viewer the layout resolved, and its shell.context
// read. Importable from tests only: `testOnlyTarget` in src/test/arch/layers.ts
// refuses every production edge to a `*.builders` module.
import { readOk } from "@/data/read";
import type { ApprovalItem } from "@/data/contracts/approvals";
import type { InterjectionItem } from "@/data/contracts/interjections";
import type { AssistantEngine } from "@/data/contracts/shell";
import type { ActionResult } from "@/server/kernel";
import type { ShellData, WorkspaceApprovals } from "./shell-data";

const SHELL_VIEWER = {
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
  avatarUrl: null,
  id: "usr_01K3F8QB7R",
  orgRole: "member",
  emailVerified: true,
  twoFactorEnabled: true,
  timeZone: "America/Los_Angeles",
  enterToSubmit: false,
} as const;

const SHELL_ORG = {
  key: "org_acme",
  slug: "acme",
  name: "Acme Robotics",
} as const;

const SHELL_CONTEXT = readOk({
  orgs: [SHELL_ORG],
  workspaces: [{ slug: "core-platform", name: "Core platform" }],
});

/** The shell data the layout's viewer yields, with any field overridden. */
export function shellData(overrides: Partial<ShellData> = {}): ShellData {
  return {
    org: SHELL_ORG,
    viewer: SHELL_VIEWER,
    context: SHELL_CONTEXT,
    approvals: {
      workspaces: [shellWorkspace()],
      truncated: false,
      readAt: SHELL_NOW,
    },
    feed: readOk({ items: [], unread: 0 }),
    counts: null,
    ...overrides,
  };
}

/** The instant the builders' reads were made: 2026-09-23 09:31:08Z. */
export const SHELL_NOW = Date.parse("2026-09-23T09:31:08Z");

/** One parked call, ten minutes from the read, with any field overridden. */
export function approvalItem(
  overrides: Partial<ApprovalItem> = {},
): ApprovalItem {
  return {
    id: "apr_01K5RS8F3J",
    runId: "run_01K5RS7M2E",
    tool: "github__create_release@2",
    agentKey: "acme.core.release-manager",
    requester: "usr_01K3F8QB7R",
    mandateId: null,
    rule: "role_grant:rg_0093",
    autoEligibility: null,
    createdAt: "2026-09-23T09:24:20Z",
    expiresAt: "2026-09-23T09:40:20Z",
    ...overrides,
  };
}

/** One workspace's share of the drawer: nothing parked, nothing resolved, unless overridden. */
export function shellWorkspace(
  overrides: Partial<WorkspaceApprovals> = {},
): WorkspaceApprovals {
  return {
    slug: "core-platform",
    name: "Core platform",
    pending: readOk({ items: [], more: false }),
    interjections: readOk({ items: [], more: false }),
    resolved: readOk({ items: [], more: false }),
    ...overrides,
  };
}

/** One open question, raised 3m 36s before the read with a 30-minute window. */
export function interjectionItem(
  overrides: Partial<InterjectionItem> = {},
): InterjectionItem {
  return {
    id: "inj_01K5RSA4TW",
    runId: "tse_01K5RS9D3K",
    agentKey: "acme.core.release-manager",
    question: "Which branch should the release cut from?",
    raisedAt: "2026-09-23T09:27:32Z",
    expiresAt: "2026-09-23T09:57:32Z",
    answeredAt: null,
    answer: null,
    answeredBy: null,
    kind: "question",
    raisedSeq: null,
    body: null,
    repository: null,
    path: null,
    receiptId: null,
    ...overrides,
  };
}

/**
 * The flyout's engine read as `readAssistantEngine` answers it: a ready
 * engine, with any field overridden.
 */
export function engineRead(
  overrides: Partial<AssistantEngine> = {},
): ActionResult<AssistantEngine> {
  return { ok: true, value: { state: "ready", error: null, ...overrides } };
}
