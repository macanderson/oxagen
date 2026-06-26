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

export default async function ExplorePage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <GraphExplorer />
      </div>
    </div>
  );
}
