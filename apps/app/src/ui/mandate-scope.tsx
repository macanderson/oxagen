// The tools a mandate covers (#2957): its scope, as the patterns it was granted
// over. Shared because three surfaces render a mandate and the scope is a pure
// function of `MandateRow.tools` — nothing about it belongs to the page it is
// drawn on, and two copies of it are two places for the same fact to be
// dropped. It already was: the Tools ledger and the Agents table each rendered
// a mandate's consequences and limits and neither rendered its scope, so two
// mandates differing only in what they may be drawn against were the same row.
import { useTranslations } from "next-intl";
import type { MandateRow } from "@/data/contracts/mandates";
import { mono } from "./control-styles";

/**
 * The pattern that matches every tool at every version. A mandate scoped `*`
 * and one scoped `payments.read@*` are the difference between an agent that
 * may call everything and one that may call a single tool. It is called out
 * rather than printed, because a reader should not have to notice one
 * character among a list of patterns to see that a mandate is unrestricted.
 *
 * This is a claim about authority, so it is checked against the gate rather
 * than assumed: `toolMatches` reaches `matchGlob`, which returns true for the
 * literal pattern `*` before any conversion
 * (`packages/mcp-config/src/permissions.ts:65`). So the badge is sound — `*`
 * really does match every tool the gate will ever be asked about.
 *
 * It is not complete, and deliberately so. `**` matches everything too and
 * renders here as its own text. A badge that guessed at every unrestricted
 * spelling would be claiming more than it can check; leaving the pattern
 * visible under-claims and hands the reader the evidence, which is the
 * direction a mandate surface may be wrong in.
 */
const EVERY_TOOL = "*";

export function MandateScope({
  tools,
  inline = false,
}: {
  tools: MandateRow["tools"];
  /**
   * One line with the patterns joined by commas, as the design's Grant panel
   * prints them, rather than one pattern to a line as a table cell does.
   */
  inline?: boolean;
}) {
  const t = useTranslations("ui.mandateScope");
  if (tools.includes(EVERY_TOOL))
    return (
      <span
        data-scope="every-tool"
        className="rounded bg-foreground px-1.5 py-0.5 text-xs font-medium text-background"
      >
        {t("everyTool")}
      </span>
    );
  // The view model admits an empty list, and an empty cell is ambiguous between
  // "covers nothing" and "not shown" — the same ambiguity the unlimited column
  // states as *no limit* rather than leaving blank. A mandate covering no
  // pattern authorizes no call, which is a fact worth reading.
  if (tools.length === 0)
    return (
      <span data-scope="no-tool" className="text-muted-foreground">
        {t("noTool")}
      </span>
    );
  if (inline)
    return (
      <span data-scope="patterns" className={`${mono} break-all text-xs`}>
        {tools.join(", ")}
      </span>
    );
  return (
    <ul data-scope="patterns" className="flex flex-col gap-0.5">
      {tools.map((pattern) => (
        <li key={pattern} className={`${mono} break-all text-xs`}>
          {pattern}
        </li>
      ))}
    </ul>
  );
}
