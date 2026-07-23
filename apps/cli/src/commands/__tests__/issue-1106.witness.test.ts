import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../settings/resolve.js", () => ({
  loadSettings: () => ({ settings: {} }),
}));

import { loadAgents } from "../../agents/loader.js";
import { loadCommands } from "../../slash/loader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("reads project .oxagen fixtures and exposes the documented coverage command", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oxagen-issue-1106-"));
  roots.push(cwd);
  mkdirSync(join(cwd, ".oxagen", "agents"), { recursive: true });
  mkdirSync(join(cwd, ".oxagen", "commands"), { recursive: true });
  writeFileSync(
    join(cwd, ".oxagen", "agents", "reviewer.md"),
    "---\nname: reviewer\n---\nReview code.\n",
  );
  writeFileSync(
    join(cwd, ".oxagen", "commands", "review.md"),
    "---\ndescription: Review code\n---\nReview $ARGUMENTS.\n",
  );

  const agents = loadAgents({ cwd, userAgentsDir: join(cwd, "user-agents") });
  const commands = loadCommands({
    cwd,
    userCommandsDir: join(cwd, "user-commands"),
  });

  expect(agents.get("reviewer")?.systemPrompt).toContain("Review code.");
  expect(commands.get("review")?.template).toContain("Review $ARGUMENTS.");

  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };
  expect(pkg.scripts?.["test:coverage"]).toBe("vitest run --coverage");
});
