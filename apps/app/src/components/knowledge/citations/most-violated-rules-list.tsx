import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TruncatedText } from "@/components/ui/truncated-text";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import type { CitedMemoryStat } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";

export interface MostViolatedRulesListProps {
  rules: CitedMemoryStat[];
  memoryPageHref: string;
}

/**
 * Ranked list of RULE/FACT memories agents have cited-then-broken. A
 * VIOLATION compliance outcome means an agent's action contradicted a
 * promoted rule at the time it was cited — this is the compliance-risk
 * surface of the dashboard, so it always leads with the violation count.
 */
export function MostViolatedRulesList({
  rules,
  memoryPageHref,
}: MostViolatedRulesListProps) {
  return (
    <section aria-labelledby="most-violated-rules-heading">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert
          className="h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <h3
          id="most-violated-rules-heading"
          className="text-sm font-semibold text-foreground"
        >
          Most Violated Rules
        </h3>
      </div>
      {rules.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No violations recorded"
          description="No promoted rule was broken by a cited action in this window."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rules.map((rule) => (
            <li
              key={rule.memoryId}
              className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5"
            >
              <Badge className="border-0 bg-red-500/15 text-red-700 shrink-0 dark:text-red-400">
                {rule.violationCount.toLocaleString()} violation
                {rule.violationCount === 1 ? "" : "s"}
              </Badge>
              <div className="min-w-0 flex-1">
                <Link href={memoryPageHref} className="hover:underline">
                  <TruncatedText
                    text={rule.lesson}
                    lines={2}
                    markdown={false}
                  />
                </Link>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {rule.memoryClass} · {rule.citationCount.toLocaleString()}{" "}
                  total citations
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
