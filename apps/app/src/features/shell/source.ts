// The shell renders for the viewer `requireViewer` admits to the organization:
// signed in, a member, MFA satisfied, on the canonical slug. A stranger or an
// unknown slug is a 404 before anything renders, exactly as for the page
// inside the shell. No read runs here: `shell.context` (org and workspace
// lists) is bound in WL-11 as the kernel seam's first production caller.
import "server-only";
import { requireViewer } from "@/server/scope";
import type { ShellData } from "./shell-data";

export async function shellSource(org: string): Promise<ShellData> {
  const viewer = await requireViewer(org);
  return {
    org: { slug: viewer.org.slug, name: viewer.org.name },
    viewer: { name: viewer.user.name, email: viewer.user.email },
  };
}
