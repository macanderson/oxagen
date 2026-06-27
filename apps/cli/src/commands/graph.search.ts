/** `oxagen graph search …` — unified natural-language (vector) search across the
 *  entire knowledge graph, via the org-scoped `/graph/search` API. */
import { apiPost } from "../lib/api.js";

export interface GraphSearchOptions {
  query: string;
  kinds?: string;
  labels?: string;
  limit?: string;
  /** commander: `--system` => true, `--no-system` => false, omitted => undefined. */
  system?: boolean;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export async function handleGraphSearch(opts: GraphSearchOptions): Promise<void> {
  // --system => isSystem=true, --no-system => false, neither => undefined (both).
  const isSystem = opts.system === true ? true : opts.system === false ? false : undefined;

  const result = await apiPost("graph/search", {
    query: opts.query,
    kinds: splitCsv(opts.kinds),
    labels: splitCsv(opts.labels),
    limit: opts.limit ? parseInt(opts.limit, 10) : 10,
    isSystem,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
