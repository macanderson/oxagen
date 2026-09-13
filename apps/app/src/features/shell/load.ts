// Load everything the shell shows for one organization, in parallel, through
// the read port. The organization read is the guard: a 404 there means the
// organization does not exist for this viewer, and the caller renders not-found
// (never a hint that it exists). Every other failure stays a `Read` failure the
// client renders honestly.
import type { ShellReadPort } from "@/data/ports";
import type { Scope } from "@/data/scope";
import type { ShellData } from "./shell-data";

export type ShellLoad = { kind: "ok"; data: ShellData } | { kind: "not_found" };

export type ShellLoadQuery = {
  /** The organization slug from the URL. */
  org: string;
  scope: Scope;
  userId: string;
};

export async function loadShellData(
  port: ShellReadPort,
  { org, scope, userId }: ShellLoadQuery,
): Promise<ShellLoad> {
  const [context, counts, notifications, engine, runs, account] =
    await Promise.all([
      port.context(scope, userId),
      port.navCounts(scope),
      port.notifications(scope, userId),
      port.assistantEngine(scope),
      port.recentRuns(scope),
      port.account(scope, userId),
    ]);
  if (!context.ok && context.reason === "error" && context.status === 404)
    return { kind: "not_found" };
  return {
    kind: "ok",
    data: {
      org,
      context,
      counts,
      notifications,
      engine,
      // The command menu simply omits runs it could not read.
      runs: runs.ok ? runs.value : [],
      account,
    },
  };
}

/** Whether a workspace slug belongs to the loaded organization. Unknown when the context read failed. */
export function workspaceExists(
  data: Pick<ShellData, "context">,
  ws: string,
): boolean | "unknown" {
  if (!data.context.ok) return "unknown";
  return data.context.value.workspaces.some((w) => w.slug === ws);
}
