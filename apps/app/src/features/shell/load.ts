// Load what the shell shows for one organization through the read port. The
// organization read is the guard: a 404 there means the organization does not
// exist for this viewer, and the caller renders not-found (never a hint that it
// exists). Every other failure stays a `Read` failure the client renders
// honestly.
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
  const context = await port.context(scope, userId);
  if (!context.ok && context.reason === "error" && context.status === 404)
    return { kind: "not_found" };
  return { kind: "ok", data: { org, context } };
}
