/**
 * `CodeMapProvider` adapter — answers "everything related to <concept>" queries
 * by calling the platform `code.map` capability over REST. Enables the engine's
 * `code_map` tool when the CLI is linked to a workspace.
 *
 * Best-effort: any transport/HTTP failure degrades to an empty bundle so a
 * coding turn never fails just because the semantic map is unavailable.
 */
import type { CodeMapProvider, CodeMapBundle } from "@oxagen/agent-engine";

export interface CodeMapApiOptions {
  apiUrl: string;
  token: string;
  orgSlug: string;
  workspaceSlug: string;
}

const EMPTY: CodeMapBundle = { files: [], symbols: [], calls: [], recentChanges: [] };

export function createCodeMapProvider(opts: CodeMapApiOptions): CodeMapProvider {
  return {
    async query(conceptQuery, queryOpts) {
      try {
        const res = await fetch(`${opts.apiUrl}/api/v1/code/map`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.token}`,
            "x-org-slug": opts.orgSlug,
            "x-workspace-slug": opts.workspaceSlug,
          },
          body: JSON.stringify({
            query: conceptQuery,
            limit: queryOpts?.limit,
            domain: queryOpts?.domain,
            kinds: queryOpts?.kinds,
          }),
        });
        if (!res.ok) return EMPTY;
        return (await res.json()) as CodeMapBundle;
      } catch {
        return EMPTY;
      }
    },
  };
}
