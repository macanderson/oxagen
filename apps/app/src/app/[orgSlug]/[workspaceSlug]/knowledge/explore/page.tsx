/**
 * page.tsx — Knowledge → Explore.
 *
 * The read-only knowledge-graph explorer, mounted as a tab of Knowledge. The
 * surrounding Knowledge layout renders the tab strip and asserts membership,
 * so this page is thin: it renders the (client) explorer component, which
 * streams graph data from `/api/v1/graph/explore`.
 */
import { GraphExplorer } from "@/components/knowledge/graph-explorer";

export const dynamic = "force-dynamic";

export default async function ExplorePage({
  searchParams,
}: {
  // Next 16: searchParams is async. `?focus=<publicId>` deep-links the explorer
  // onto a specific node — used by the chat "Grounded in" citation's "View in
  // graph" action so a cited fact opens directly in a live graph view.
  searchParams: Promise<{ focus?: string | string[] }>;
}) {
  const { focus } = await searchParams;
  const focusNodeId = Array.isArray(focus) ? focus[0] : focus;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <GraphExplorer {...(focusNodeId ? { focusNodeId } : {})} />
      </div>
    </div>
  );
}
