import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(
  new URL("../../.claude/workflows/", import.meta.url),
);
const workflows = readdirSync(directory).filter((name) =>
  /^mc-.*\.js$/.test(name),
);
const sha = "a".repeat(40);
const lane = {
  lane: "one",
  branch: "mc/test-one",
  head_sha: sha,
  summary: "Done",
  ci_state: "not-opened",
  open_gaps: [],
};
interface Call {
  prompt: string;
  label: string;
}

async function run(name: string, results: unknown[], remote: unknown) {
  const source = readFileSync(`${directory}/${name}`, "utf8")
    .split("const session =")
    .at(0)
    ?.replace("export const meta", "const meta");
  if (!source) throw new Error(`Missing workflow source: ${name}`);
  const calls: Call[] = [];
  let laneIndex = 0;
  const value: unknown = await runInNewContext(
    `(async () => { ${source}\nreturn runSession(testSession, 'spec') })()`,
    {
      args: {},
      testSession: {
        id: "test",
        title: "Test",
        lanes: results.map((_, index) => ({
          id: index === 0 ? "one" : "two",
          owns: [],
          task: "Build",
          done: "Done",
        })),
      },
      phase: () => {},
      log: () => {},
      parallel: (tasks: Array<() => Promise<unknown>>) =>
        Promise.all(tasks.map((task) => task())),
      agent: (prompt: string, options: { label: string }) => {
        calls.push({ prompt, label: options.label });
        if (options.label.startsWith("scout:"))
          return Promise.resolve({
            base_sha: sha,
            lanes: [{ id: "one", still_open: true }],
          });
        if (options.label.startsWith("lane:"))
          return Promise.resolve(results[laneIndex++]);
        if (options.label.startsWith("verify:")) return Promise.resolve(remote);
        if (options.label.startsWith("integrate:"))
          return Promise.resolve({
            ...lane,
            pr_url: "https://example.test/pr/1",
          });
        return Promise.resolve({ fixed: [], remaining: [], ci_state: "green" });
      },
    },
  );
  return { value, calls };
}

for (const name of workflows) {
  describe(name, () => {
    it.each(["", "--help", "mc/../main", "mc/name;whoami", "mc/name.lock"])(
      "refuses invalid branch %s before remote access",
      async (branch) => {
        const { calls } = await run(name, [{ ...lane, branch }], null);
        expect(
          calls.some((call) => /^(verify|integrate):/.test(call.label)),
        ).toBe(false);
      },
    );
    it.each([
      null,
      { exists: false, branch: `refs/heads/${lane.branch}`, head_sha: sha },
      {
        exists: true,
        branch: `refs/heads/${lane.branch}`,
        head_sha: "b".repeat(40),
      },
    ])("refuses absent or changed remote heads", async (remote) => {
      const { calls } = await run(name, [lane], remote);
      expect(calls.some((call) => call.label.startsWith("integrate:"))).toBe(
        false,
      );
    });
    it.each(["main", "mc/test-two"])(
      "rejects an unassigned branch %s",
      async (branch) => {
        const { calls } = await run(name, [{ ...lane, branch }], null);
        expect(
          calls.some((call) => /^(verify|integrate):/.test(call.label)),
        ).toBe(false);
      },
    );
    it("rejects duplicate commit claims before remote verification", async () => {
      const { calls } = await run(
        name,
        [lane, { ...lane, lane: "two", branch: "mc/test-two" }],
        null,
      );
      expect(
        calls.some((call) => /^(verify|integrate):/.test(call.label)),
      ).toBe(false);
    });
    it("stops on duplicate lane identities", async () => {
      const { calls } = await run(name, [lane, lane], null);
      expect(
        calls.some((call) => /^(verify|integrate):/.test(call.label)),
      ).toBe(false);
    });
    it("stops on a missing lane result", async () => {
      const { calls } = await run(name, [null], null);
      expect(calls.some((call) => call.label.startsWith("integrate:"))).toBe(
        false,
      );
    });
    it("merges the verified commit rather than an unpinned branch", async () => {
      const { calls } = await run(name, [lane], {
        exists: true,
        branch: `refs/heads/${lane.branch}`,
        head_sha: sha,
      });
      const integration = calls.find((call) =>
        call.label.startsWith("integrate:"),
      );
      expect(integration?.prompt).toContain(
        `${sha} (refs/heads/${lane.branch})`,
      );
      expect(calls.some((call) => call.label.startsWith("review:"))).toBe(true);
    });
  });
}
