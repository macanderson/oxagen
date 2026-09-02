import { describe, expect, it } from "vitest";
import {
  extractFindings,
  scanStringLiterals,
  computeMobileParity,
} from "./check_mobile_parity.mjs";

describe("scanStringLiterals", () => {
  it("does not desync on an apostrophe inside a block comment", () => {
    const src = `
      /** the layout's critical path, that's fine. */
      export const x = "hidden w-40 shrink-0 md:block";
    `;
    const literals = scanStringLiterals(src).map((l) => l.value);
    expect(literals).toContain("hidden w-40 shrink-0 md:block");
  });

  it("does not desync on an apostrophe inside a line comment", () => {
    const src = `
      // here's a note
      export const x = "hidden w-40 shrink-0 md:block";
    `;
    const literals = scanStringLiterals(src).map((l) => l.value);
    expect(literals).toContain("hidden w-40 shrink-0 md:block");
  });

  it("does not extract a literal quoted purely inside a comment", () => {
    const src = `
      /**
       * Usage: <aside className="hidden w-48 shrink-0 md:block">...</aside>
       */
      export const y = 1;
    `;
    const literals = scanStringLiterals(src).map((l) => l.value);
    expect(literals).not.toContain("hidden w-48 shrink-0 md:block");
  });

  it("reports the correct line number for a literal", () => {
    const src = `const a = 1;\nconst b = 2;\nconst c = "hidden md:block";\n`;
    const found = scanStringLiterals(src).find(
      (l) => l.value === "hidden md:block",
    );
    expect(found?.line).toBe(3);
  });
});

describe("extractFindings — token detection", () => {
  it("flags a standalone `hidden` token alongside a visible-at-breakpoint token", () => {
    const src = `<div className="hidden md:block">x</div>`;
    const findings = extractFindings(src, "f.tsx");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "f.tsx",
      type: "A",
      literal: "hidden md:block",
    });
  });

  it("does NOT flag `md:hidden` alone (not the standalone `hidden` token)", () => {
    const src = `<div className="md:hidden">x</div>`;
    expect(extractFindings(src, "f.tsx")).toHaveLength(0);
  });

  it("does NOT flag `overflow-hidden` (not the standalone `hidden` token)", () => {
    const src = `<div className="overflow-hidden rounded-lg">x</div>`;
    expect(extractFindings(src, "f.tsx")).toHaveLength(0);
  });

  it("flags the pattern inside a template literal", () => {
    const src = "const cls = `hidden ${extra} md:flex`;";
    const findings = extractFindings(src, "f.tsx");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.type).toBe("A");
  });

  it("flags `max-md:hidden` as type B", () => {
    const src = `<div className="max-md:hidden">x</div>`;
    const findings = extractFindings(src, "f.tsx");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "B", literal: "max-md:hidden" });
  });

  it("does not flag a lone `hidden` with no breakpoint-visible token", () => {
    const src = `<div className="hidden">x</div>`;
    expect(extractFindings(src, "f.tsx")).toHaveLength(0);
  });
});

describe("computeMobileParity — coverage", () => {
  const findings = [
    {
      file: "a.tsx",
      line: 10,
      literal: "hidden w-48 md:block",
      type: "A" as const,
    },
  ];

  it("flags an uncovered finding", () => {
    const { violations } = computeMobileParity(findings, { entries: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.type).toBe("uncovered-finding");
  });

  it("covers a finding whose literal includes the entry's match, in the same file", () => {
    const manifest = {
      entries: [
        {
          file: "a.tsx",
          match: "hidden w-48",
          kind: "reflow" as const,
          equivalent: "Shown via MobileNav instead of the sidebar.",
        },
      ],
    };
    const { violations } = computeMobileParity(findings, manifest);
    expect(
      violations.filter((v) => v.type === "uncovered-finding"),
    ).toHaveLength(0);
  });

  it("does not cover a finding when the entry is for a different file", () => {
    const manifest = {
      entries: [
        {
          file: "b.tsx",
          match: "hidden w-48",
          kind: "reflow" as const,
          equivalent: "Shown via MobileNav instead of the sidebar.",
        },
      ],
    };
    const { violations } = computeMobileParity(findings, manifest);
    expect(violations.some((v) => v.type === "uncovered-finding")).toBe(true);
  });
});

describe("computeMobileParity — stale and pending entries", () => {
  it("flags a stale entry that covers no finding", () => {
    const manifest = {
      entries: [
        {
          file: "a.tsx",
          match: "not-present",
          kind: "reflow" as const,
          equivalent: "Some mobile equivalent surface.",
        },
      ],
    };
    const { violations } = computeMobileParity([], manifest);
    expect(violations.some((v) => v.type === "stale-entry")).toBe(true);
  });

  it("suppresses the stale violation for a pending entry but warns instead", () => {
    const manifest = {
      entries: [
        {
          file: "a.tsx",
          match: "not-present",
          kind: "reflow" as const,
          equivalent: "Some mobile equivalent surface.",
          pending: true,
        },
      ],
    };
    const { violations, warnings } = computeMobileParity([], manifest);
    expect(violations.some((v) => v.type === "stale-entry")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("pending-entry");
  });
});

describe("computeMobileParity — kind=hidden validation", () => {
  const findings = [
    { file: "a.tsx", line: 1, literal: "hidden md:block", type: "A" as const },
  ];

  it("rejects a reason outside security/performance", () => {
    const manifest = {
      entries: [
        {
          file: "a.tsx",
          match: "hidden md:block",
          kind: "hidden" as const,
          reason: "design-preference",
          justification: "x".repeat(130),
          approvedBy: "mac@oxagen.sh",
        },
      ],
    };
    const { violations } = computeMobileParity(findings, manifest);
    expect(violations.some((v) => v.type === "invalid-hidden-reason")).toBe(
      true,
    );
  });

  it("rejects a justification shorter than 120 chars", () => {
    const manifest = {
      entries: [
        {
          file: "a.tsx",
          match: "hidden md:block",
          kind: "hidden" as const,
          reason: "security",
          justification: "too short",
          approvedBy: "mac@oxagen.sh",
        },
      ],
    };
    const { violations } = computeMobileParity(findings, manifest);
    expect(
      violations.some((v) => v.type === "invalid-hidden-justification"),
    ).toBe(true);
  });

  it("rejects a missing approvedBy", () => {
    const manifest = {
      entries: [
        {
          file: "a.tsx",
          match: "hidden md:block",
          kind: "hidden" as const,
          reason: "performance",
          justification: "x".repeat(130),
        },
      ],
    };
    const { violations } = computeMobileParity(findings, manifest);
    expect(violations.some((v) => v.type === "invalid-hidden-approval")).toBe(
      true,
    );
  });

  it("accepts a fully valid hidden entry", () => {
    const manifest = {
      entries: [
        {
          file: "a.tsx",
          match: "hidden md:block",
          kind: "hidden" as const,
          reason: "security",
          justification: "x".repeat(130),
          approvedBy: "mac@oxagen.sh",
        },
      ],
    };
    const { violations } = computeMobileParity(findings, manifest);
    expect(violations).toHaveLength(0);
  });
});

describe("computeMobileParity — kind=reflow validation", () => {
  const findings = [
    { file: "a.tsx", line: 1, literal: "hidden md:block", type: "A" as const },
  ];

  it("rejects an equivalent shorter than 20 chars", () => {
    const manifest = {
      entries: [
        {
          file: "a.tsx",
          match: "hidden md:block",
          kind: "reflow" as const,
          equivalent: "too short",
        },
      ],
    };
    const { violations } = computeMobileParity(findings, manifest);
    expect(violations.some((v) => v.type === "invalid-reflow-equivalent")).toBe(
      true,
    );
  });

  it("accepts a fully valid reflow entry", () => {
    const manifest = {
      entries: [
        {
          file: "a.tsx",
          match: "hidden md:block",
          kind: "reflow" as const,
          equivalent: "Re-presented via MobileBottomBar navigation.",
        },
      ],
    };
    const { violations } = computeMobileParity(findings, manifest);
    expect(violations).toHaveLength(0);
  });
});
