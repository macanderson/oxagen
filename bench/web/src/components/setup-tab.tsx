// Imported only into the client graph (via benchmark-dashboard), so no own
// "use client" directive is needed.
import { Card, SectionTitle, Pill } from "@/components/atoms";
import { AGENTS, EVALS, CATEGORY_LABELS, CATEGORY_ORDER } from "@/lib/data";
import type { AgentId, Difficulty } from "@/lib/types";

const DIFFICULTIES: readonly { id: Difficulty; label: string; hint: string }[] = [
  { id: "easy", label: "Easy", hint: "Lower cost, higher pass rate" },
  { id: "medium", label: "Medium", hint: "Balanced baseline" },
  { id: "hard", label: "Hard", hint: "Higher cost, more failures" },
];

export function SetupTab({
  selectedAgents,
  selectedEvals,
  difficulty,
  onToggleAgent,
  onToggleEval,
  onSetDifficulty,
  onSelectAllEvals,
  onClearEvals,
  onRun,
}: {
  readonly selectedAgents: readonly AgentId[];
  readonly selectedEvals: readonly string[];
  readonly difficulty: Difficulty;
  readonly onToggleAgent: (id: AgentId) => void;
  readonly onToggleEval: (id: string) => void;
  readonly onSetDifficulty: (d: Difficulty) => void;
  readonly onSelectAllEvals: () => void;
  readonly onClearEvals: () => void;
  readonly onRun: () => void;
}): React.ReactElement {
  const canRun = selectedAgents.length > 0 && selectedEvals.length > 0;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <SectionTitle title="Agents" hint={`${selectedAgents.length} of ${AGENTS.length} selected`} />
        <div className="flex flex-wrap gap-2">
          {AGENTS.map((agent) => (
            <Pill
              key={agent.id}
              active={selectedAgents.includes(agent.id)}
              color={agent.color}
              onClick={() => onToggleAgent(agent.id)}
            >
              {agent.name}
            </Pill>
          ))}
        </div>
        <div className="mt-4 space-y-1.5 text-sm text-graphite-400">
          {AGENTS.filter((a) => selectedAgents.includes(a.id)).map((a) => (
            <div key={a.id} className="flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ backgroundColor: a.color }} />
              <span className="text-graphite-300">{a.name}</span>
              <span className="text-graphite-400">— {a.tagline}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle title="Difficulty" />
        <div className="flex flex-col gap-2">
          {DIFFICULTIES.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onSetDifficulty(d.id)}
              aria-pressed={difficulty === d.id}
              className={
                "flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors " +
                (difficulty === d.id
                  ? "border-ember/60 bg-ember/10"
                  : "border-graphite-700 bg-graphite-850 hover:border-graphite-600")
              }
            >
              <span className="font-medium text-graphite-100">{d.label}</span>
              <span className="text-xs text-graphite-400">{d.hint}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <SectionTitle
          title="Evaluations"
          hint={`${selectedEvals.length} of ${EVALS.length} selected`}
        />
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={onSelectAllEvals}
            className="rounded-md border border-graphite-700 px-2.5 py-1 text-xs text-graphite-300 hover:border-graphite-600 hover:text-graphite-100"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={onClearEvals}
            className="rounded-md border border-graphite-700 px-2.5 py-1 text-xs text-graphite-300 hover:border-graphite-600 hover:text-graphite-100"
          >
            Clear
          </button>
        </div>
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {CATEGORY_ORDER.map((category) => (
            <div key={category}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ember">
                {CATEGORY_LABELS[category]}
              </div>
              <div className="flex flex-col gap-2">
                {EVALS.filter((e) => e.category === category).map((e) => {
                  const active = selectedEvals.includes(e.id);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => onToggleEval(e.id)}
                      aria-pressed={active}
                      title={e.description}
                      className={
                        "rounded-lg border px-3 py-2 text-left text-sm transition-colors " +
                        (active
                          ? "border-ember/50 bg-ember/10 text-graphite-100"
                          : "border-graphite-700 bg-graphite-850 text-graphite-300 hover:border-graphite-600")
                      }
                    >
                      {e.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="lg:col-span-2 flex items-center justify-between gap-4">
        <p className="text-sm text-graphite-400">
          {canRun
            ? `Ready to run ${selectedAgents.length * selectedEvals.length} tasks (${selectedAgents.length} agents × ${selectedEvals.length} evals).`
            : "Select at least one agent and one evaluation."}
        </p>
        <button
          type="button"
          onClick={onRun}
          disabled={!canRun}
          className="rounded-lg bg-ember px-6 py-3 text-sm font-semibold text-graphite-950 transition-colors hover:bg-ember-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          Run Benchmark →
        </button>
      </div>
    </div>
  );
}
