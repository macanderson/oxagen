// The shell's reads come from the one data source (`dataSource().shell`, plan
// §4.5), for the viewer `requireViewer` admits to the organization: signed in,
// a member, MFA satisfied, on the canonical slug. A stranger or an unknown slug
// is a 404 before the shell reads anything, exactly as for the page inside it.
import "server-only";
import type { ShellReadPort } from "@/data/ports";
import type { Scope } from "@/data/scope";
import { dataSource } from "@/data/source";
import { requireViewer } from "@/server/scope";

export type ShellSource = {
  port: ShellReadPort;
  /** The organization-level scope the shell reads in. */
  scope: Scope;
  userId: string;
};

export async function shellSource(org: string): Promise<ShellSource> {
  const viewer = await requireViewer(org);
  return {
    port: (await dataSource()).shell,
    scope: viewer.scope,
    userId: viewer.userId,
  };
}
