import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgents } from "../agents/loader";
import { scaffoldAgent } from "../agents/write";
import { loadSkills } from "../skills/loader";
import { scaffoldSkill } from "../skills/write";
import { loadCommands } from "../slash/loader";
import { scaffoldCommand } from "../slash/write";

describe("TOML-only runtime artifacts", () => {
  it("loads canonical TOML and ignores foreign Markdown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "toml-cutover-"));
    const home = await mkdtemp(join(tmpdir(), "toml-home-"));
    const diagnostics: string[] = [];
    await mkdir(join(cwd, ".oxagen", "agents"), { recursive: true });
    await mkdir(join(cwd, ".oxagen", "skills", "review"), { recursive: true });
    await mkdir(join(cwd, ".oxagen", "commands"), { recursive: true });
    await mkdir(join(cwd, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".oxagen", "agents", "reviewer.toml"),
      'schema_version = 1\nkind = "agent"\nname = "reviewer"\ndescription = "Review"\ndeveloper_instructions = "Review carefully."\ntools = ["read_file"]\nskills = ["review"]\nunresolved_tools = []\n',
    );
    await writeFile(
      join(cwd, ".claude", "agents", "foreign.md"),
      "---\nname: foreign\n---\nForeign",
    );
    await writeFile(
      join(cwd, ".oxagen", "skills", "review", "skill.toml"),
      'schema_version = 1\nkind = "skill"\nname = "review"\ndescription = "Review"\ninstructions = "Review with evidence."\nreferences = []\n',
    );
    await writeFile(
      join(cwd, ".oxagen", "commands", "audit.toml"),
      'schema_version = 1\nkind = "command"\nname = "audit"\ndescription = "Audit"\nprompt = "Audit $ARGUMENTS"\n',
    );

    expect([
      ...loadAgents({
        cwd,
        userAgentsDir: join(home, "agents"),
        onDiagnostic: (entry) => diagnostics.push(entry.code),
      }).keys(),
    ]).toEqual(["reviewer"]);
    expect([...loadSkills({ cwd, userHomeDir: home }).keys()]).toEqual([
      "review",
    ]);
    expect([
      ...loadCommands({ cwd, userCommandsDir: join(home, "commands") }).keys(),
    ]).toEqual(["audit"]);
    expect(diagnostics).toEqual([]);
  });

  it("excludes unresolved agents and scaffolds TOML without clobbering", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "toml-cutover-"));
    const diagnostics: string[] = [];
    await mkdir(join(cwd, ".oxagen", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".oxagen", "agents", "blocked.toml"),
      'schema_version = 1\nkind = "agent"\nname = "blocked"\ndescription = "Blocked"\ndeveloper_instructions = "Blocked."\ntools = []\nskills = []\nunresolved_tools = ["Task"]\n',
    );
    expect(
      loadAgents({
        cwd,
        userAgentsDir: join(cwd, "none"),
        onDiagnostic: (entry) => diagnostics.push(entry.code),
      }),
    ).toHaveLength(0);
    expect(diagnostics).toEqual(["artifact_needs_review"]);

    expect(
      scaffoldAgent({ cwd, name: "new-agent" }).path.endsWith("new-agent.toml"),
    ).toBe(true);
    expect(scaffoldAgent({ cwd, name: "new-agent" }).created).toBe(false);
    expect(
      scaffoldSkill({ cwd, name: "new-skill" }).path.endsWith("skill.toml"),
    ).toBe(true);
    expect(
      scaffoldCommand({ cwd, name: "new-command" }).path.endsWith(
        "new-command.toml",
      ),
    ).toBe(true);
  });
});
