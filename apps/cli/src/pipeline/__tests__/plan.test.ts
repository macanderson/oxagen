import { describe, expect, it } from "vitest";
import { runPlan } from "../plan.js";
import { formatPipelineLine, type PipelineLogEntry } from "../pipeline-logging.js";

function capture() {
  const lines: string[] = [];
  const log = (e: PipelineLogEntry) => lines.push(formatPipelineLine(e));
  return { log, lines };
}

describe("runPlan", () => {
  it("creates one implementation task per graph-impacted file, plus verify and judge", async () => {
    const { log, lines } = capture();
    const out = await runPlan(
      { objective: "add widgets", graphImpactedFiles: ["src/a.ts", "src/b.ts"] },
      log,
    );
    const titles = out.tasks.map((t) => t.title);
    expect(titles).toContain("Update src/a.ts");
    expect(titles).toContain("Update src/b.ts");
    // verify depends on both impl tasks; judge depends on verify.
    const verify = out.tasks.find((t) => t.id === "verify")!;
    const judge = out.tasks.find((t) => t.id === "judge")!;
    expect(verify.dependsOn).toHaveLength(2);
    expect(judge.dependsOn).toEqual(["verify"]);
    // Logged start + done with the task count.
    expect(lines.some((l) => l.includes("tool=plan") && l.includes("status=start"))).toBe(true);
    expect(lines.some((l) => l.includes("tool=plan") && l.includes("status=done") && l.includes("tasks=4"))).toBe(true);
  });

  it("still produces a stable task id when a path slugifies to empty", async () => {
    const { log } = capture();
    const out = await runPlan({ objective: "x", graphImpactedFiles: ["///"] }, log);
    // The impl task keeps a usable id even when the path has no slug characters.
    expect(out.tasks[0]!.id).toMatch(/^impl-1$/);
  });

  it("falls back to a single implementation task when the graph found no files", async () => {
    const { log } = capture();
    const out = await runPlan({ objective: "fix the bug" }, log);
    expect(out.tasks.filter((t) => t.id.startsWith("impl") || t.title === "fix the bug")).toHaveLength(1);
    expect(out.tasks.map((t) => t.id)).toEqual(["impl-1", "verify", "judge"]);
  });
});
