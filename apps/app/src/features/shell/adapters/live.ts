// The shell's live reads, before Batch 3 wires them. Each one answers honestly
// that it is not wired yet (HTTP 501) rather than inventing data, so a build
// against real stores renders a shell that names what is missing.
//
// What backs each read once wired (plan §3.2):
//   context          org.organizations, org.org_users, workspace.workspaces (✅)
//   navCounts        agent.approval_requests, iam.principals, agent.context_promotions, tacho.incidents (✅/🟡)
//   notifications    notification.notifications (✅)
//   assistantEngine  the stella-serve health endpoint (🟡, ADR-053)
//   recentRuns       agent.agent_runs through @oxagen/run-ledger (🟡)
//   account          auth.users, user_preferences, auth sessions (✅)
//
// PROMOTE: src/data/adapters/live/shell.ts (Batch 3).
import { readError } from "@/data/not-backed";
import type { ShellReadPort } from "../port";

const notWired = (read: string) => readError(`shell_${read}_not_wired`, 501);

export const liveShell: ShellReadPort = {
  context: () => Promise.resolve(notWired("context")),
  navCounts: () => Promise.resolve(notWired("nav_counts")),
  notifications: () => Promise.resolve(notWired("notifications")),
  assistantEngine: () => Promise.resolve(notWired("assistant_engine")),
  recentRuns: () => Promise.resolve(notWired("recent_runs")),
  account: () => Promise.resolve(notWired("account")),
};
