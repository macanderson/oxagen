import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  docSurfaces,
  findIndexMismatches,
  findMismatches,
  indexSurfaces,
} from "./check-capability-docs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const doc = (line: string) =>
  `# agent.suspend\n\n**Capability:** \`suspend_agent\`\n${line}\n**Mutates:** yes\n`;

describe("docSurfaces", () => {
  it("reads the comma list, with or without backticks", () => {
    expect(docSurfaces(doc("**Surfaces:** api, mcp, cli"))).toEqual([
      "api",
      "mcp",
      "cli",
    ]);
    expect(docSurfaces(doc("**Surfaces:** `api`, `cli`"))).toEqual([
      "api",
      "cli",
    ]);
  });

  it("reads `none …` as an empty array and a missing line as null", () => {
    expect(
      docSurfaces(doc("**Surfaces:** none (`surfaces: []`; app seam only)")),
    ).toEqual([]);
    expect(docSurfaces(doc("**Domain:** agent"))).toBeNull();
  });
});

describe("findMismatches", () => {
  const caps = [
    { file: "agent.suspend.ts", name: "suspend_agent", surfaces: ["api"] },
    {
      file: "agent.register.ts",
      name: "register_agent",
      surfaces: ["api", "cli"],
    },
    { file: "no.doc.ts", name: "no_doc", surfaces: ["api", "mcp"] },
  ];

  it("names the doc that promises a surface the contract refuses", () => {
    const docs: Record<string, string> = {
      "agent.suspend": doc("**Surfaces:** api, mcp"),
      "agent.register": doc("**Surfaces:** cli, api"),
    };
    expect(findMismatches(caps, (stem) => docs[stem] ?? null)).toEqual([
      {
        stem: "agent.suspend",
        name: "suspend_agent",
        doc: ["api", "mcp"],
        contract: ["api"],
      },
    ]);
  });

  it("skips a capability without a doc and a doc without the line", () => {
    const docs: Record<string, string> = {
      "agent.suspend": doc("**Domain:** agent"),
      "agent.register": doc("**Surfaces:** api, cli"),
    };
    expect(findMismatches(caps, (stem) => docs[stem] ?? null)).toEqual([]);
  });
});

const INDEX = [
  "| Name | Contract | Surfaces |",
  "|---|---|---|",
  "| [resolve_approval](agent.approval.resolve.md) | [agent.approval.resolve.ts](../../packages/oxagen/src/contracts/agent.approval.resolve.ts) | api, mcp, agent |",
  "| [authorize_cli](auth.cli.authorize.md) | [auth.cli.authorize.ts](../../packages/oxagen/src/contracts/auth.cli.authorize.ts) | none |",
  "| `resolve_mcp_servers` | [agent.mcp.resolve.ts](../../packages/oxagen/src/contracts/agent.mcp.resolve.ts) | api |",
].join("\n");

describe("indexSurfaces", () => {
  it("keys each row by its contract file, reading `none` as an empty array", () => {
    expect(indexSurfaces(INDEX)).toEqual(
      new Map([
        ["agent.approval.resolve.ts", ["api", "mcp", "agent"]],
        ["auth.cli.authorize.ts", []],
        ["agent.mcp.resolve.ts", ["api"]],
      ]),
    );
  });
});

describe("findIndexMismatches", () => {
  it("names the row that promises a surface the contract refuses (negative)", () => {
    const caps = [
      {
        file: "agent.approval.resolve.ts",
        name: "resolve_approval",
        surfaces: ["api", "mcp"],
      },
      { file: "auth.cli.authorize.ts", name: "authorize_cli", surfaces: [] },
      {
        file: "agent.mcp.resolve.ts",
        name: "resolve_mcp_servers",
        surfaces: ["api"],
      },
      { file: "no.row.ts", name: "no_row", surfaces: ["api"] },
    ];
    expect(findIndexMismatches(caps, INDEX)).toEqual([
      {
        file: "agent.approval.resolve.ts",
        name: "resolve_approval",
        index: ["api", "mcp", "agent"],
        contract: ["api", "mcp"],
      },
    ]);
  });

  // The committed index against the contract sources themselves, so the
  // check holds without a regenerated manifest. Four rows had drifted
  // (#2950): resolve_approval and resolve_mcp_consent still listed the agent
  // surface ADR-175 removed, get_export_status left out mcp, and
  // list_price_entries left out cli.
  it("matches every contract's declared surfaces in the committed _index.md", () => {
    const index = readFileSync(
      join(ROOT, "docs/capabilities/_index.md"),
      "utf8",
    );
    const caps = [...indexSurfaces(index).keys()].flatMap((file) => {
      const path = join(ROOT, "packages/oxagen/src/contracts", file);
      if (!existsSync(path)) return [];
      const source = readFileSync(path, "utf8");
      const name = source.match(/name: "([a-z0-9_]+)"/)?.[1];
      const declared = source.match(/surfaces: \[([^\]]*)\]/)?.[1];
      if (name === undefined || declared === undefined) return [];
      const surfaces = [...declared.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
      return [{ file, name, surfaces }];
    });
    expect(caps.length).toBeGreaterThan(300);
    expect(findIndexMismatches(caps, index)).toEqual([]);
  });
});
