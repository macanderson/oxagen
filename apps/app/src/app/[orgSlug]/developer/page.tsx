import { redirect } from "next/navigation";
import { org } from "@/lib/routes";
import { requestScopeSlugs } from "@/lib/request-path";

/**
 * Developer root → MCP (its first tab). The org slug is read from the request
 * URL, NOT `params` — see lib/request-path.ts (awaiting `params` before
 * `redirect()` 500s the shell under Cache Components).
 */
export default async function DeveloperRoot() {
  const { orgSlug } = await requestScopeSlugs();
  if (!orgSlug) redirect("/");
  redirect(org.developer.mcp({ orgSlug }));
}
