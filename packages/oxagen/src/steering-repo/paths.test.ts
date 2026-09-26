import { describe, expect, it } from "vitest";
import { fixtureRepo, organizationFixtureRepo } from "./fixture-repo";
import {
  agentFilePath,
  classifySteeringRepoPath,
  ledgerFileName,
  ledgerFilePath,
  ledgerPeriod,
  LEGACY_GOVERNANCE_PATH,
  LEGACY_KEEP_FILES,
  LEGACY_OXAGEN_DIR,
  LEGACY_RULES_DIR,
  LEGACY_SKILLS_CONFIG_PATH,
  LEGACY_SKILLS_DIR,
  LEGACY_WORKSPACE_TOML_PATH,
  parseLedgerFileName,
  policyFilePath,
  policyTestsPath,
  recordFileName,
  recordLineageFromPath,
  serverFolderPath,
  serverTomlPath,
  skillFilePath,
  skillFolderPath,
  toolbeltFilePath,
  toolsLockPath,
  toolsTomlPath,
  WORKSPACE_LINK_PATH,
} from "./paths";

describe("steering repo paths", () => {
  it("builds each path the Shared contract names, relative to the root", () => {
    expect(agentFilePath("a-intel.core.release-bot")).toBe(
      "agents/a-intel.core.release-bot.toml",
    );
    expect(recordFileName("a-intel.billing.refunds-over-100")).toBe(
      "a-intel.billing.refunds-over-100.md",
    );
    expect(skillFolderPath("a-intel.brand.voice")).toBe(
      "steering/skills/a-intel.brand.voice",
    );
    expect(skillFilePath("a-intel.brand.voice")).toBe(
      "steering/skills/a-intel.brand.voice/SKILL.md",
    );
    expect(serverFolderPath("billing")).toBe("tools/servers/billing");
    expect(serverTomlPath("billing")).toBe("tools/servers/billing/server.toml");
    expect(toolsTomlPath("billing")).toBe("tools/servers/billing/tools.toml");
    expect(toolsLockPath("billing")).toBe(
      "tools/servers/billing/tools.lock.json",
    );
    expect(toolbeltFilePath("refunds")).toBe("tools/toolbelts/refunds.toml");
    expect(policyFilePath("money")).toBe("policy/money.cedar");
    expect(policyTestsPath("money")).toBe("policy/money.tests.jsonl");
  });

  it("keeps today's .oxagen/ paths byte for byte until the move", () => {
    expect(LEGACY_OXAGEN_DIR).toBe(".oxagen");
    expect(LEGACY_RULES_DIR).toBe(".oxagen/rules");
    expect(LEGACY_GOVERNANCE_PATH).toBe(".oxagen/rules/governance.toml");
    expect(LEGACY_WORKSPACE_TOML_PATH).toBe(".oxagen/workspace.toml");
    expect(LEGACY_SKILLS_DIR).toBe(".oxagen/skills");
    expect(LEGACY_SKILLS_CONFIG_PATH).toBe(".oxagen/skills.toml");
    expect(LEGACY_KEEP_FILES).toEqual([
      ".oxagen/rules/.gitkeep",
      ".oxagen/proposals/.gitkeep",
    ]);
    expect(WORKSPACE_LINK_PATH).toBe(".oxagen/workspace.json");
  });
});

describe("the ledger's files", () => {
  const at = new Date("2026-09-26T23:30:00Z");

  it("names the period for each rotation, in UTC", () => {
    expect(ledgerPeriod(at, "day")).toBe("2026-09-26");
    expect(ledgerPeriod(at, "week")).toBe("2026-W39");
    expect(ledgerPeriod(at, "month")).toBe("2026-09");
    expect(ledgerPeriod(at, "year")).toBe("2026");
  });

  it("puts a week in the ISO year of its Thursday", () => {
    // 2026-01-01 is a Thursday; 2027-01-01 is a Friday in 2026's last week;
    // 2024-12-30 is a Monday in 2025's first week; a Sunday closes its week.
    expect(ledgerPeriod(new Date("2026-01-01T00:00:00Z"), "week")).toBe(
      "2026-W01",
    );
    expect(ledgerPeriod(new Date("2027-01-01T12:00:00Z"), "week")).toBe(
      "2026-W53",
    );
    expect(ledgerPeriod(new Date("2024-12-30T12:00:00Z"), "week")).toBe(
      "2025-W01",
    );
    expect(ledgerPeriod(new Date("2026-09-27T12:00:00Z"), "week")).toBe(
      "2026-W39",
    );
  });

  it("numbers a period's files from the second one on", () => {
    expect(ledgerFileName("2026-09")).toBe("2026-09.jsonl");
    expect(ledgerFileName("2026-09", 2)).toBe("2026-09.002.jsonl");
    expect(ledgerFilePath("2026-W39", 12)).toBe(
      "steering/promotions/2026-W39.012.jsonl",
    );
    for (const bad of [0, 1.5, 1000]) {
      expect(() => ledgerFileName("2026-09", bad)).toThrow(RangeError);
    }
  });

  it("reads a ledger file's name back", () => {
    expect(parseLedgerFileName("2026-09.jsonl")).toEqual({
      period: "2026-09",
      n: 1,
    });
    expect(parseLedgerFileName("2026-09.002.jsonl")).toEqual({
      period: "2026-09",
      n: 2,
    });
    expect(parseLedgerFileName("2026-W39.jsonl")?.period).toBe("2026-W39");
    expect(parseLedgerFileName("2026-09-26.jsonl")?.period).toBe("2026-09-26");
    expect(parseLedgerFileName("2026.jsonl")?.period).toBe("2026");
    expect(parseLedgerFileName("2026-09.001.jsonl")).toBeNull();
    expect(parseLedgerFileName("promotions.jsonl")).toBeNull();
    expect(parseLedgerFileName("2026-09.json")).toBeNull();
  });
});

describe("classifySteeringRepoPath", () => {
  it("gives every file in the fixture repos a place", () => {
    for (const repo of [fixtureRepo(), organizationFixtureRepo()]) {
      for (const path of repo.keys()) {
        expect(classifySteeringRepoPath(path), path).not.toBe("unknown");
      }
    }
  });

  it.each([
    ["AGENTS.md", "agents-md"],
    ["CLAUDE.md", "claude-md"],
    ["README.md", "readme"],
    [".gitattributes", "gitattributes"],
    ["workspace.toml", "workspace"],
    ["steering/governance.toml", "governance"],
    ["steering/promotions/2026-09.jsonl", "ledger"],
    ["steering/promotions/2026-09.002.jsonl", "ledger"],
    ["steering/promotions/notes.jsonl", "unknown"],
    ["steering/promotions/2026/09.jsonl", "unknown"],
    ["steering/billing/a-intel.billing.refunds-over-100.md", "record"],
    ["steering/a-intel.top.md", "record"],
    ["steering/skills/a-intel.brand.voice/SKILL.md", "skill-record"],
    ["steering/skills/a-intel.brand.voice/words.md", "skill-asset"],
    ["steering/skills/a-intel.brand.voice/assets/logo.svg", "skill-asset"],
    ["steering/skills/a-intel.loose.md", "record"],
    ["steering/memory/platform/a-intel.platform.ci-cache-key.md", "record"],
    ["steering/billing/notes.txt", "unknown"],
    ["agents/a-intel.core.release-bot.toml", "agent"],
    ["agents/nested/a.toml", "unknown"],
    ["agents/readme.md", "unknown"],
    ["tools/servers/billing/server.toml", "server"],
    ["tools/servers/billing/tools.toml", "server-tools"],
    ["tools/servers/billing/tools.lock.json", "server-lock"],
    ["tools/servers/billing/openapi.yaml", "server-definition"],
    ["tools/servers/billing/overlay.yaml", "server-definition"],
    ["tools/servers/crm/schema.graphql", "server-definition"],
    ["tools/servers/ledger/proto/ledger/v1/ledger.proto", "server-definition"],
    ["tools/servers/billing/tests/calls.jsonl", "server-test"],
    ["tools/servers/billing/notes.md", "unknown"],
    ["tools/servers/billing/docs/a.md", "unknown"],
    ["tools/servers/billing", "unknown"],
    ["tools/toolbelts/refunds.toml", "toolbelt"],
    ["tools/toolbelts/refunds.json", "unknown"],
    ["tools/other/x.toml", "unknown"],
    ["policy/schema.cedarschema", "cedar-schema"],
    ["policy/money.cedar", "policy"],
    ["policy/money.tests.jsonl", "policy-tests"],
    ["policy/notes.md", "unknown"],
    ["policy/nested/money.cedar", "unknown"],
    ["docs/intro.md", "unknown"],
    ["steering//double.md", "unknown"],
    ["steering/../escape.md", "unknown"],
  ])("classifies %s as %s", (path, kind) => {
    expect(classifySteeringRepoPath(path)).toBe(kind);
  });

  it("reads the lineage a record's path names", () => {
    expect(
      recordLineageFromPath("steering/billing/a-intel.billing.refunds-over-100.md"),
    ).toBe("a-intel.billing.refunds-over-100");
    expect(
      recordLineageFromPath("steering/skills/a-intel.brand.voice/SKILL.md"),
    ).toBe("a-intel.brand.voice");
    expect(recordLineageFromPath("workspace.toml")).toBeNull();
    expect(
      recordLineageFromPath("steering/skills/a-intel.brand.voice/words.md"),
    ).toBeNull();
  });
});
