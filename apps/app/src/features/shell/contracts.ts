// View models the shell reads: the organization and workspace context behind the
// sidebar and switchers, the nav counts, notifications, the assistant engine's
// health and the Account dialog. Spec vocabulary (spec §3, App. A), never the
// mockup's strings.
//
// PROMOTE: these belong in src/data/contracts/shell.ts (lane L1 owns src/data).
// They live here until L1's contracts land so the shell does not wait on it.
import { z } from "zod";
import { Currency, PublicId } from "@/data/contracts/common";

/** Where an organization's stores live (ADR-042, App. A `org.data_planes`). */
export const DataPlaneKind = z.enum(["shared", "dedicated"]);
export type DataPlaneKind = z.infer<typeof DataPlaneKind>;

export const ShellOrg = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  /** The billing plan's display name, or null when the plan is not recorded. */
  plan: z.string().nullable(),
  dataPlane: DataPlaneKind,
  region: z.string().nullable(),
});
export type ShellOrg = z.infer<typeof ShellOrg>;

export const ShellWorkspace = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  /** The workspace's one main repo (spec §3), e.g. `acme/platform`. */
  mainRepo: z.string().nullable(),
  productionBranch: z.string().nullable(),
  /** Registered agents, or null when not counted. Never an invented zero. */
  agentCount: z.number().int().nonnegative().nullable(),
});
export type ShellWorkspace = z.infer<typeof ShellWorkspace>;

export const ShellViewer = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
});
export type ShellViewer = z.infer<typeof ShellViewer>;

export const ShellContext = z.object({
  viewer: ShellViewer,
  org: ShellOrg,
  /** Every organization the viewer belongs to, for the organization switcher. */
  orgs: z.array(ShellOrg.pick({ slug: true, name: true, plan: true })).min(1),
  workspaces: z.array(ShellWorkspace),
});
export type ShellContext = z.infer<typeof ShellContext>;

/** Counts shown beside sidebar items. A null count is "not recorded", shown as nothing. */
export const NavCounts = z.object({
  pendingApprovals: z.number().int().nonnegative().nullable(),
  agents: z.number().int().nonnegative().nullable(),
  openProposals: z.number().int().nonnegative().nullable(),
  openIncidents: z.number().int().nonnegative().nullable(),
});
export type NavCounts = z.infer<typeof NavCounts>;

/**
 * Notification kinds. Every kind maps to a frame kind or an audit event, never
 * to something invented for a bell (mockup notifications footer).
 */
export const NotificationKind = z.enum([
  "approval.requested",
  "approval.resolved",
  "budget.breached",
  "context_pr.opened",
  "run.proven",
  "repository.indexed",
  "reconciliation.exception",
  "kill_switch.flipped",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** How loudly a notification speaks; the icon and colour follow it. */
export const NotificationSeverity = z.enum([
  "success",
  "info",
  "attention",
  "critical",
]);
export type NotificationSeverity = z.infer<typeof NotificationSeverity>;

export const NotificationItem = z.object({
  id: PublicId,
  kind: NotificationKind,
  severity: NotificationSeverity,
  title: z.string().min(1),
  body: z.string(),
  unread: z.boolean(),
  at: z.iso.datetime(),
  /** The run the notification is about, when it is about one. */
  runId: PublicId.nullable(),
});
export type NotificationItem = z.infer<typeof NotificationItem>;

export const NotificationFeed = z.object({
  items: z.array(NotificationItem),
});
export type NotificationFeed = z.infer<typeof NotificationFeed>;

/**
 * The in-app agent's engine (`stella serve`, ADR-053). The engine is a required
 * service: nothing falls back to an in-process loop, so a down engine is shown
 * by name (plan W9, spec §18).
 */
export const AssistantEngine = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("up"),
    model: z.string().min(1),
    version: z.string().min(1),
  }),
  z.object({
    status: z.literal("down"),
    httpStatus: z.number().int().min(100).max(599),
    version: z.string().nullable(),
    lastHealthyAt: z.iso.datetime().nullable(),
  }),
]);
export type AssistantEngine = z.infer<typeof AssistantEngine>;

/** A recent run the command menu offers to open. */
export const CommandRun = z.object({
  id: PublicId,
  workspace: z.string().min(1),
  agentKey: z.string().min(1),
});
export type CommandRun = z.infer<typeof CommandRun>;

export const SecondFactorKind = z.enum(["totp", "passkey"]);
export type SecondFactorKind = z.infer<typeof SecondFactorKind>;

export const AccountView = z.object({
  profile: z.object({
    name: z.string().min(1),
    email: z.email(),
    emailVerifiedAt: z.iso.datetime().nullable(),
    principalId: PublicId,
    /** Who manages the identity (an SSO directory), or null for a local account. */
    managedBy: z.string().nullable(),
    roles: z.array(z.object({ scope: z.string(), role: z.string() })),
  }),
  preferences: z.object({
    locale: z.string().min(2),
    displayCurrency: Currency,
    timeZone: z.string().min(1),
  }),
  security: z.object({
    signInProvider: z.string().nullable(),
    passwordSignIn: z.boolean(),
    factors: z.array(
      z.object({
        kind: SecondFactorKind,
        enrolledAt: z.iso.datetime().nullable(),
        recoveryCodesRemaining: z.number().int().nonnegative().nullable(),
      }),
    ),
    sessions: z.array(
      z.object({
        id: z.string().min(1),
        device: z.string(),
        location: z.string().nullable(),
        lastActiveAt: z.iso.datetime(),
        current: z.boolean(),
      }),
    ),
  }),
  privacy: z.object({
    retentionYears: z.number().int().positive().nullable(),
    legalHolds: z.number().int().nonnegative().nullable(),
  }),
});
export type AccountView = z.infer<typeof AccountView>;
