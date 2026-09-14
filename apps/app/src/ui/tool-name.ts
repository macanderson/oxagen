// Tool names as the registry records them: `server__local_name@version`
// (`github__create_pull_request@2.3.0`). The label and category a page shows
// come from the registry when it has them; these are the fallbacks for a name
// the registry has not classified yet, derived from the name's verb.
import type { ToolCategory } from "@/data/contracts";

export type ToolNameParts = { name: string; version: string | null };

/** Split `name@version` at the last `@`. */
export function parseToolId(id: string): ToolNameParts {
  const at = id.lastIndexOf("@");
  return at > 0
    ? { name: id.slice(0, at), version: id.slice(at + 1) || null }
    : { name: id, version: null };
}

function localName(name: string): string {
  return name.split("__").pop() ?? name;
}

/** "github__create_pull_request" → "Create pull request". */
export function humanizeToolName(name: string): string {
  const words = localName(name).replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const VERB_CATEGORY: ReadonlyArray<readonly [RegExp, ToolCategory]> = [
  [/^(get|list|search|read|fetch|find|recall|describe|show)$/, "read"],
  [/^(query|select|aggregate|export)$/, "query"],
  [/^(write|edit|move|copy|trash|mkdir)$/, "file"],
  [/^(bash|run|exec|execute|eval)$/, "exec"],
  [/^(post|send|reply|forward|publish|upload)$/, "message"],
  [/^(pay|refund|purchase|charge|transfer|buy|payout)$/, "finance"],
  [/^(deploy|scale|pause|restart|provision)$/, "infra"],
  [/^(grant|share|rotate|revoke|invite)$/, "access"],
  [/^(merge|rebase|tag|release|push|fork)$/, "vcs"],
];

/** Classify by the local name's first word; anything unrecognised is a record write. */
export function classifyToolName(name: string): ToolCategory {
  const verb = (localName(name).split("_")[0] ?? "").toLowerCase();
  for (const [pattern, category] of VERB_CATEGORY)
    if (pattern.test(verb)) return category;
  return "record";
}
