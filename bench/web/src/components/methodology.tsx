// Imported only into the client graph (via benchmark-dashboard), so no own
// "use client" directive is needed.
import { Card, SectionTitle } from "@/components/atoms";

const FAIRNESS_RULES: readonly string[] = [
  "A comparison is apples-to-apples ONLY when dataset + harness + underlying base model are held constant.",
  "Oxagen is a scaffold on top of a base model, not a model of its own — an honest claim is \"Oxagen's scaffold on model X resolved N% vs agent Y on model X — same tasks, same harness,\" never a bare percentage in isolation.",
  "Runs are single-attempt (pass@1) unless a row explicitly says otherwise.",
  "Cost figures depend on the base model's pricing at the time of the run, not on anything Oxagen controls.",
];

const CAVEATS: readonly string[] = [
  "Our own runs are self-reported — none are yet third-party checkmarked on swebench.com.",
  "SWE-bench Verified is a high-quality, human-screened subset, but later community audits have found some flawed or underspecified tasks even at the top of the range.",
  "A benchmark score is a proxy for real-world usefulness, not a guarantee of it.",
];

/**
 * The fairness rules that govern how any row on this page may be compared to
 * another, plus the caveats we're not allowed to omit.
 */
export function Methodology(): React.ReactElement {
  return (
    <Card>
      <SectionTitle title="Fairness & methodology" />
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-graphite-400">
            Fairness rules
          </h3>
          <ul className="mt-2 flex flex-col gap-2 text-sm text-graphite-300">
            {FAIRNESS_RULES.map((rule) => (
              <li key={rule} className="flex gap-2">
                <span className="text-ember">•</span>
                <span>{rule}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-graphite-400">Caveats</h3>
          <ul className="mt-2 flex flex-col gap-2 text-sm text-graphite-300">
            {CAVEATS.map((caveat) => (
              <li key={caveat} className="flex gap-2">
                <span className="text-amber-400">•</span>
                <span>{caveat}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
