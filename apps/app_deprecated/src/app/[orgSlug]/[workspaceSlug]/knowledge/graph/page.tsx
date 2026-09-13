/**
 * page.tsx — Knowledge → Graph.
 *
 * The read-only knowledge-graph explorer, mounted as a tab of Knowledge. The
 * Knowledge layout renders the tab strip and `[orgSlug]/layout.tsx` asserts
 * session + org membership, so this page is thin: it renders the (client) WebGL
 * explorer canvas (`GraphExplorer` — streams from `/api/v1/graph/explore`) plus
 * the Browse/Search/Query side panel (`GraphSidePanel`, `./_panels/`), which
 * calls the graph and ontology capabilities directly via `invoke()` in
 * `./actions.ts` — a completely separate data path from the canvas.
 *
 * Layout: canvas + panel sit side by side on large screens; the panel drops
 * below the canvas on narrower viewports so both stay usable on mobile.
 */
import { GraphExplorer } from "@/components/knowledge/graph-explorer";
import { GraphSidePanel } from "./_panels/graph-side-panel";

export default async function GraphPage({
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
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      <div className="min-h-[420px] min-w-0 flex-1 lg:min-h-0">
        <GraphExplorer {...(focusNodeId ? { focusNodeId } : {})} />
      </div>
      <div className="min-h-0 lg:h-full lg:w-[26rem] lg:shrink-0">
        <GraphSidePanel />
      </div>
    </div>
  );
}
