// Imported only into the client graph (via benchmark-dashboard), so no own
// "use client" directive is needed.
import { Card, SectionTitle } from "@/components/atoms";

interface Step {
  readonly n: number;
  readonly title: string;
  readonly body: string;
}

const STEPS: readonly Step[] = [
  {
    n: 1,
    title: "The agent gets a real GitHub issue",
    body:
      "It's handed the issue's problem statement and a checkout of the repo pinned at the commit where the bug (or missing feature) actually existed — no synthetic prompt, no toy repo.",
  },
  {
    n: 2,
    title: "It edits files autonomously",
    body:
      "The agent reads the codebase, decides what to change, and produces a patch (a git diff) exactly the way it would for a real pull request — no human in the loop.",
  },
  {
    n: 3,
    title: "The patch is applied and the repo's own tests run",
    body:
      "The diff is applied to a clean checkout, and the task's hidden FAIL_TO_PASS and PASS_TO_PASS tests run inside a Docker container. These are the maintainers' own tests, not a benchmark-specific check.",
  },
  {
    n: 4,
    title: "“Resolved” means those tests pass",
    body:
      "The agent never sees or grades its own output. A task counts as resolved only if every FAIL_TO_PASS test now passes and every PASS_TO_PASS test still passes.",
  },
];

/**
 * A concrete, step-by-step walkthrough of what a SWE-bench evaluation
 * actually does, so a reader can verify the claim rather than take a score on
 * faith.
 */
export function HowItWorks(): React.ReactElement {
  return (
    <Card>
      <SectionTitle title="What the benchmark actually does" hint="one task, start to finish" />
      <ol className="grid gap-4 sm:grid-cols-2">
        {STEPS.map((step) => (
          <li key={step.n} className="flex gap-3 rounded-lg bg-graphite-850 p-4">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ember/20 text-sm font-bold text-ember">
              {step.n}
            </span>
            <div>
              <p className="text-sm font-semibold text-graphite-100">{step.title}</p>
              <p className="mt-1 text-sm text-graphite-300">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
