import { describe, it, expect } from "vitest";
import { buildProgram } from "../program.js";
import { describeCliCommands } from "../commands/meta.js";

describe("buildProgram", () => {
  it("builds the oxagen command tree with no side effects", () => {
    const program = buildProgram();
    expect(program.name()).toBe("oxagen");
    expect(program.commands.length).toBeGreaterThan(10);
  });
});

// ADR-112 phase 1, MC spec §2.1: the old word does not appear in the product,
// and `--help` is the product. The commands themselves stay, because every
// machine enrolled so far was enrolled with `oxagen tacho enroll` and that
// string is in scripts, runbooks, and the managed settings documents MDM has
// already pushed. Hiding is the whole change; removing would be an outage.
describe("the deprecated tacho group", () => {
  const program = buildProgram();

  it("is absent from the top-level help", () => {
    expect(program.helpInformation()).not.toMatch(/tacho/i);
  });

  it("still carries every subcommand, so nothing enrolled breaks", () => {
    const tacho = program.commands.find((c) => c.name() === "tacho");
    expect(tacho, "the group itself must still be registered").toBeDefined();
    expect(tacho?.commands.map((c) => c.name()).sort()).toEqual([
      "enroll",
      "export",
      "hosts",
      "reassign",
      "status",
      "unenroll",
      "verify",
    ]);
  });

  // Telemetry classifies an invocation against `program.commands`, which keeps
  // hidden entries, so a deprecated call is still attributed rather than
  // recorded as unknown.
  it("stays visible to command classification", () => {
    expect(program.commands.map((c) => c.name())).toContain("tacho");
  });

  // Phase 1b left this group's shape alone on purpose. A machine enrolled last
  // month runs `oxagen tacho status` from a runbook, and it must mean what it
  // meant then — this machine — not "an agent whose name you forgot to pass".
  it.each(["enroll", "status", "unenroll"])(
    "keeps `%s` host-scoped, taking no agent argument (negative)",
    (name) => {
      const sub = program.commands
        .find((c) => c.name() === "tacho")
        ?.commands.find((c) => c.name() === name);
      expect(sub, "the subcommand must still be registered").toBeDefined();
      expect(sub?.registeredArguments ?? []).toEqual([]);
    },
  );
});

// ADR-112 phase 1b: the seven wrapping commands now also live on `oxagen agent`,
// which is the name §2.1 gives them. These assert the shape of the tree; which
// handler each merged name reaches is asserted in agent-wrap-dispatch.test.ts.
describe("the agent group after the wrapping commands moved onto it", () => {
  const program = buildProgram();
  const agent = program.commands.find((c) => c.name() === "agent");
  const sub = (name: string) => agent?.commands.find((c) => c.name() === name);

  it("carries every wrapping command alongside the governance ones", () => {
    expect(agent, "the group must exist").toBeDefined();
    expect(agent?.commands.map((c) => c.name()).sort()).toEqual([
      "enroll",
      "env",
      "export",
      "hosts",
      "reassign",
      "register",
      "status",
      "unenroll",
      "verify",
    ]);
  });

  // The two governance signatures this phase changed. Additive: every caller
  // that passes an agent keeps working, and omitting it now means this machine.
  it.each(["status", "unenroll"])(
    "makes `%s`'s agent argument optional",
    (name) => {
      const args = sub(name)?.registeredArguments ?? [];
      expect(args.map((a) => a.name())).toEqual(["agent"]);
      expect(args[0]?.required).toBe(false);
    },
  );

  // It was `requiredOption` while `agent enroll` only served the one-time
  // enrollment token. The session path takes no token at all.
  it("no longer requires --token on enroll", () => {
    const token = sub("enroll")?.options.find((o) => o.long === "--token");
    expect(token, "--token must still be offered").toBeDefined();
    // `required` is Commander for "takes a value" and stays true; `mandatory`
    // is `requiredOption`, and that is the one this phase relaxed.
    expect(token?.required).toBe(true);
    expect(token?.mandatory).toBe(false);
  });

  it("takes no argument on enroll, which names this machine and nothing else", () => {
    expect(sub("enroll")?.registeredArguments ?? []).toEqual([]);
  });
});

describe("describeCliCommands", () => {
  const meta = describeCliCommands(buildProgram());
  const byName = new Map(meta.map((m) => [m.name, m]));

  it("surfaces the same top-level commands `oxagen --help` lists", () => {
    // A representative spread across the surviving governance command tree.
    for (const name of [
      "budget",
      "cost",
      "graph",
      "init",
      "memory",
      "trace",
      "secret",
    ]) {
      expect(byName.has(name), `missing ${name}`).toBe(true);
    }
  });

  it("carries each command's one-line description", () => {
    expect(byName.get("cost")?.description).toMatch(/cost/i);
    expect(byName.get("init")?.description).toMatch(/workspace/i);
  });

  it("derives an argument hint from the command's declared arguments", () => {
    // `trace <executionId>` → required argument.
    expect(byName.get("trace")?.argumentHint).toBe("<executionId>");
    // `cost` takes only options → no positional hint.
    expect(byName.get("cost")?.argumentHint).toBeUndefined();
  });

  it("keeps the retired agent commands registered as stubs", () => {
    for (const name of [
      "agents",
      "solve",
      "fleet",
      "daemon",
      "view",
      "replay",
    ]) {
      expect(byName.get(name)?.description).toMatch(/retired/i);
    }
  });

  it("keeps every command excised with the runtime registered as a stub", () => {
    // ADR-043: a stale `oxagen sandbox …` must fail with guidance pointing at
    // Stella, not with an unknown-command parse error.
    for (const name of [
      "sandbox",
      "sandbox-template",
      "code",
      "eval",
      "file-lock",
      "a2a",
      "models",
      "skill",
      "prompt",
      "command",
      "rules",
      "settings",
      "config",
      "mcp",
      "import",
      "pr",
      "recover",
      "lineage",
    ]) {
      expect(byName.get(name)?.description, `missing ${name}`).toMatch(
        /retired/i,
      );
    }
  });
});

// The Working copies tab tells people to run `oxagen init --org <org>
// --workspace <ws>`. Init once accepted neither flag, so the documented
// command failed with a parse error. And `oxagen pull` did not exist.
describe("init and pull", () => {
  const program = buildProgram();
  const cmd = (name: string) => program.commands.find((c) => c.name() === name);

  it("takes --org and --workspace on init, each with a value and no short flag", () => {
    const init = cmd("init");
    for (const long of ["--org", "--workspace"]) {
      const opt = init?.options.find((o) => o.long === long);
      expect(opt, `${long} must be offered`).toBeDefined();
      expect(opt?.required).toBe(true);
      expect(opt?.short).toBeUndefined();
    }
    expect(init?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--json", "--no-link"]),
    );
  });

  it("parses the documented init command without an error", () => {
    const p = buildProgram();
    p.exitOverride();
    const init = p.commands.find((c) => c.name() === "init");
    init?.action(() => {});
    p.parse(["init", "--org", "acme", "--workspace", "payments"], {
      from: "user",
    });
    expect(init?.opts()).toMatchObject({ org: "acme", workspace: "payments" });
  });

  it("registers pull with its four options", () => {
    const pull = cmd("pull");
    expect(pull?.description()).toMatch(/published/);
    expect(pull?.options.map((o) => o.long).sort()).toEqual([
      "--binding",
      "--dry-run",
      "--force",
      "--json",
    ]);
  });
});

// `get_run` declares the cli surface, so `oxagen run show <run-id>` must be on
// the tree with the run id required and --json offered (#2951).
describe("run show", () => {
  const program = buildProgram();
  const show = program.commands
    .find((c) => c.name() === "run")
    ?.commands.find((c) => c.name() === "show");

  it("takes one required run id and offers --json", () => {
    expect(show, "run show must be registered").toBeDefined();
    const args = show?.registeredArguments ?? [];
    expect(args.map((a) => a.name())).toEqual(["run-id"]);
    expect(args[0]?.required).toBe(true);
    expect(show?.options.map((o) => o.long)).toEqual(["--json"]);
  });
});
