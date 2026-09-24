"use server";
// The command menu's search (mockup `cmdMenu()`: "search_tools · this search
// is itself a governed call"). One `search_tools` read through the kernel, so
// IAM decides which kinds the viewer may see and the invocation is audited
// like any other. A read carried in a write's shape, because INV-19 has every
// exported function of a `"use server"` module answer with an `ActionResult`.
//
// The action takes the query and the slugs in the URL; the workspace comes
// from the viewer resolved against them, never from an id in the input.
import { toolsSearch } from "@oxagen/oxagen/contracts/tools.search";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import type { SearchRowView } from "./commands";

/** The longest query `search_tools` accepts. */
const QUERY_MAX = 500;

export async function searchCommands(
  org: string,
  ws: string,
  query: string,
): Promise<ActionResult<{ rows: SearchRowView[] }>> {
  if (query.length > QUERY_MAX)
    return { ok: false, reason: "invalid", code: "too_long", field: "query" };
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: toolsSearch,
    input: { query },
    page: "shell",
  });
  if (!read.ok) return readToActionResult(read);
  return {
    ok: true,
    value: {
      rows: read.value.rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        label: row.label,
        contextLine: row.contextLine,
      })),
    },
  };
}
