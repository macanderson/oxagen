import { describe, expect, it } from "vitest";
import { docSurfaces, findMismatches } from "./check-capability-docs.mjs";

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
