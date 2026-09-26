// The one import-graph architecture test (ARCHITECTURE.md §2, §4): the layer
// matrix (INV-07), the test-only targets (INV-22), the platform-package
// allowlist (INV-03, INV-05) and the client boundary (INV-21), over static,
// dynamic and relative imports alike, with the shrink-only baseline in
// baseline.json.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  clientBoundaryRefuses,
  isPlatformSpecifier,
  layerAllows,
  MINT_IMPORTERS,
  MINT_MODULE,
  platformAllows,
} from "./layers";
import {
  baselineEntries,
  describeDiff,
  diffBaseline,
  directiveOf,
  importEdges,
  listFiles,
  parse,
  parseBaseline,
  productionFiles,
  readSource,
  resolveInternal,
  ruleOf,
  type SourceText,
  WHOLE_TREE_TIMEOUT_MS,
} from "./parse";

/** Rule ids as they appear in baseline.json. */
type Rule = "layer" | "platform" | "client";
const RULES: readonly Rule[] = ["layer", "platform", "client"];

/** Every violation of one production module, as baseline entries. */
function violationsOf(source: SourceText): string[] {
  const sf = parse(source);
  const directive = directiveOf(sf);
  const from = {
    file: source.file.replace(/^src\//, "").replace(/\.tsx?$/, ""),
    directive,
  };
  const out: string[] = [];
  for (const edge of importEdges(sf)) {
    const at = `${source.file}:${String(edge.line)} ${edge.specifier}`;
    if (edge.computed) {
      out.push(`layer ${at}`);
      continue;
    }
    if (
      isPlatformSpecifier(edge.specifier) &&
      !platformAllows(source.file, edge)
    ) {
      out.push(`platform ${at}`);
    }
    // instrumentation.ts sits outside src/: the platform row is its only rule.
    if (!source.file.startsWith("src/")) continue;
    const target = resolveInternal(source.file, edge.specifier);
    if (target === null) continue;
    if (target.kind === "outside") {
      out.push(`layer ${at}`);
      continue;
    }
    if (!layerAllows(from, target.path, edge)) out.push(`layer ${at}`);
    if (
      directive === "use client" &&
      clientBoundaryRefuses(target.path, edge)
    ) {
      out.push(`client ${at}`);
    }
  }
  return out;
}

const rulesHit = (violations: readonly string[]): Set<string> =>
  new Set(violations.map(ruleOf));

describe("import graph", () => {
  it("runs on the typescript 6.0.x compiler API", () => {
    expect(ts.version).toMatch(/^6\.0\./);
  });

  it(
    "today's violations are exactly the baseline",
    () => {
      const actual = productionFiles().flatMap((file) =>
        violationsOf(readSource(file)),
      );
      const diff = diffBaseline(actual, baselineEntries(RULES));
      expect(diff, describeDiff(diff, actual)).toEqual({
        unexpected: [],
        stale: [],
      });
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it(
    "only viewer.ts and viewer.testing.ts import the MINT token, test files included",
    () => {
      const importers = listFiles("src")
        .filter(
          (file) =>
            /\.tsx?$/.test(file) && !file.startsWith("src/test/arch/probes/"),
        )
        .filter((file) =>
          importEdges(parse(readSource(file))).some((edge) => {
            const target = resolveInternal(file, edge.specifier);
            return target?.kind === "module" && target.path === MINT_MODULE;
          }),
        )
        .map((file) => file.replace(/^src\//, "").replace(/\.tsx?$/, ""));
      expect(
        importers.filter((file) => !MINT_IMPORTERS.includes(file)),
      ).toEqual([]);
      expect(importers).toContain("server/viewer");
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("fails when a violating import is deleted but its baseline entry stays", () => {
    const file = "src/ui/probe.ts";
    const violating: SourceText = {
      file,
      text: 'import { kernelRead } from "@/server/kernel";\n',
    };
    const entries = violationsOf(violating);
    expect(entries).toEqual(["layer src/ui/probe.ts:1 @/server/kernel"]);
    expect(diffBaseline(entries, entries)).toEqual({
      unexpected: [],
      stale: [],
    });
    const fixed: SourceText = { file, text: "export {};\n" };
    expect(diffBaseline(violationsOf(fixed), entries)).toEqual({
      unexpected: [],
      stale: entries,
    });
  });

  it("refuses a baseline entry under a rule no test owns", () => {
    const entry = "layerr src/ui/x.ts:1 @/server/kernel";
    expect(() => parseBaseline(JSON.stringify([entry]))).toThrow(entry);
    expect(parseBaseline(JSON.stringify(["layer x", "route-guard y"]))).toEqual(
      ["layer x", "route-guard y"],
    );
  });

  it("fails on a violation the baseline does not carry", () => {
    const entries = violationsOf({
      file: "src/ui/probe.ts",
      text: 'import { kernelRead } from "@/server/kernel";\n',
    });
    expect(diffBaseline(entries, [])).toEqual({
      unexpected: entries,
      stale: [],
    });
  });
});

// --- Probes -----------------------------------------------------------------
//
// Each file under probes/import-graph is judged as if it sat at `at`; `expect`
// is the rule it must trip, or null for a placement the matrix admits. A probe
// may be placed more than once (a rule that turns on the importer's path).

type Placement = { readonly at: string; readonly expect: Rule | null };
const PROBE_DIR = "src/test/arch/probes/import-graph";
const PROBES: Readonly<Record<string, readonly Placement[]>> = {
  // The three named in the WL-01 acceptance.
  "ui-imports-kernel.ts": [{ at: "src/ui/probe.ts", expect: "layer" }],
  "ui-imports-contract-value.tsx": [
    { at: "src/ui/probe.tsx", expect: "layer" },
  ],
  "ui-imports-contract-type.tsx": [{ at: "src/ui/probe.tsx", expect: null }],
  "ports-imports-viewer-value.ts": [
    { at: "src/data/ports.ts", expect: "layer" },
  ],
  "ports-imports-viewer-type.ts": [{ at: "src/data/ports.ts", expect: null }],
  "oxagen-kernel-invoke.ts": [
    { at: "src/features/fleet/actions.ts", expect: "platform" },
    { at: "src/server/kernel.ts", expect: null },
  ],
  "features-dynamic-database.ts": [
    { at: "src/features/fleet/reads.ts", expect: "platform" },
    { at: "src/server/tenancy-lookups.ts", expect: null },
  ],
  "oxagen-command-limits.ts": [
    // The Fleet steer dialog is admitted STEER_TEXT_MAX alone, so the reason
    // ceiling this probe imports is refused there.
    { at: "src/features/fleet/steer-fleet.tsx", expect: "platform" },
    { at: "src/ui/command-failure.ts", expect: null },
    { at: "src/ui/probe.ts", expect: "platform" },
  ],
  "oxagen-skill-frontmatter.ts": [
    { at: "src/features/create/skill-file.ts", expect: null },
    { at: "src/shared/skill-source-identity.ts", expect: null },
    { at: "src/features/create/agent-wizard.tsx", expect: "platform" },
  ],
  // INV-03: one probe per @oxagen/oxagen subpath.
  "oxagen-barrel.ts": [
    { at: "src/data/live/runs.ts", expect: "platform" },
    { at: "src/server/kernel.ts", expect: null },
  ],
  "oxagen-registry.ts": [{ at: "src/server/viewer.ts", expect: "platform" }],
  "oxagen-types.ts": [{ at: "src/data/ports.ts", expect: "platform" }],
  "oxagen-contracts-index.ts": [
    { at: "src/data/live/runs.ts", expect: "platform" },
  ],
  "oxagen-contract.ts": [{ at: "src/data/live/runs.ts", expect: null }],
  "handlers-register.ts": [
    { at: "src/features/fleet/actions.ts", expect: "platform" },
    { at: "src/server/kernel.ts", expect: null },
  ],
  // INV-03, INV-05: refused by omission.
  "tenancy.ts": [
    { at: "src/server/kernel.ts", expect: "platform" },
    { at: "instrumentation.ts", expect: "platform" },
  ],
  // #3048: the process bootstrap's four named entries, and nothing past them.
  "instrumentation-bootstrap-entries.ts": [
    { at: "instrumentation.ts", expect: null },
    { at: "src/server/kernel.ts", expect: "platform" },
    { at: "src/data/live/audit.ts", expect: "platform" },
  ],
  "instrumentation-fifth-entry.ts": [
    { at: "instrumentation.ts", expect: "platform" },
  ],
  "handlers-barrel.ts": [
    { at: "src/features/auth/cli-actions.ts", expect: "platform" },
  ],
  "auth-client.ts": [
    { at: "src/features/auth/auth-client.ts", expect: null },
    { at: "src/features/auth/ui/oauth-buttons.tsx", expect: "platform" },
    { at: "src/server/session.ts", expect: null },
  ],
  "auth-cli-auth.ts": [
    { at: "src/features/auth/cli-actions.ts", expect: "platform" },
    { at: "src/server/session.ts", expect: null },
  ],
  "billing.ts": [
    { at: "src/data/live/org.ts", expect: "platform" },
    { at: "instrumentation.ts", expect: null },
  ],
  "database-type.ts": [
    { at: "src/data/live/runs.ts", expect: "platform" },
    { at: "src/server/tenancy-lookups.ts", expect: null },
  ],
  "drizzle-orm.ts": [
    { at: "src/data/live/runs.ts", expect: "platform" },
    { at: "src/server/tenancy-lookups.ts", expect: null },
  ],
  "telemetry-chselect.ts": [
    { at: "src/data/live/audit.ts", expect: "platform" },
    { at: "instrumentation.ts", expect: "platform" },
  ],
  "telemetry-namespace.ts": [
    { at: "src/data/live/audit.ts", expect: "platform" },
    { at: "instrumentation.ts", expect: "platform" },
  ],
  "telemetry-side-effect.ts": [
    { at: "src/data/live/audit.ts", expect: "platform" },
  ],
  "telemetry-capture-error.ts": [
    { at: "src/data/live/audit.ts", expect: null },
    { at: "src/server/kernel.ts", expect: null },
  ],
  "storage-client.ts": [
    { at: "src/features/shell/export-storage.ts", expect: null },
    { at: "src/features/shell/export-download.ts", expect: "platform" },
    {
      at: "src/app/[org]/account/export/[exportId]/route.ts",
      expect: "platform",
    },
  ],
  "ui-library.ts": [{ at: "src/features/shell/sidebar.tsx", expect: null }],
  // INV-07: the layer matrix.
  "relative-feature-internals.ts": [
    { at: "src/features/onboarding/actions.ts", expect: "layer" },
    { at: "src/features/auth/actions.ts", expect: null },
  ],
  "feature-barrel.ts": [
    { at: "src/features/onboarding/new-organization.tsx", expect: null },
    { at: "src/app/[org]/page.tsx", expect: null },
  ],
  "app-imports-feature-internals.tsx": [
    { at: "src/app/[org]/page.tsx", expect: "layer" },
  ],
  "export-from-server.ts": [{ at: "src/data/read.ts", expect: "layer" }],
  "computed-import.ts": [
    { at: "src/features/fleet/reads.ts", expect: "layer" },
  ],
  "imports-data-source.ts": [
    { at: "src/server/stream-feeds.ts", expect: "layer" },
    { at: "src/data/live/runs.ts", expect: "layer" },
    { at: "src/app/[org]/page.tsx", expect: null },
    // The named module without the directive is not an action (ADR-167).
    { at: "src/features/shell/choice-actions.ts", expect: "layer" },
    { at: "src/features/shell/engine-actions.ts", expect: "layer" },
    {
      at: "src/features/shell/assistant-approval-actions.ts",
      expect: "layer",
    },
    { at: "src/features/run/actions.ts", expect: "layer" },
  ],
  // ADR-167: the record picker's actions, the flyout's engine read, its
  // parked approval cards and the Run page's later transcript pages reach the
  // port by name. Any other "use server"
  // feature module reads on demand through the kernel seam.
  "data-source-use-server.ts": [
    { at: "src/features/shell/choice-actions.ts", expect: null },
    { at: "src/features/shell/engine-actions.ts", expect: null },
    // #4162: the parked cards read their approval rows through the port.
    {
      at: "src/features/shell/assistant-approval-actions.ts",
      expect: null,
    },
    // ADR-182: a later transcript page reads the port the first page reads.
    { at: "src/features/run/actions.ts", expect: null },
    { at: "src/features/shell/account-actions.ts", expect: "layer" },
    { at: "src/features/tools/actions.ts", expect: "layer" },
  ],
  "server-imports-feature.ts": [
    { at: "src/server/kernel.ts", expect: "layer" },
  ],
  "ui-imports-server-seq.ts": [
    { at: "src/ui/hooks/stream-merge.ts", expect: "layer" },
  ],
  "shared-imports-internal.ts": [
    { at: "src/shared/safe-path.ts", expect: "layer" },
  ],
  "shared-imports-shared.ts": [
    { at: "src/shared/navigation.ts", expect: null },
    { at: "src/proxy.ts", expect: null },
  ],
  // #3049: the invitation page reads through the viewer seam, never the lookups.
  "features-imports-tenancy-lookups.ts": [
    { at: "src/features/auth/invitations.ts", expect: "layer" },
    { at: "src/server/viewer.ts", expect: null },
  ],
  "features-imports-viewer-invitation.ts": [
    { at: "src/features/auth/invitations.ts", expect: null },
  ],
  "features-imports-session.ts": [
    { at: "src/features/auth/actions.ts", expect: null },
    { at: "src/features/shell/source.ts", expect: null },
    { at: "src/ui/user-menu.tsx", expect: "layer" },
  ],
  "proxy-imports-server.ts": [
    { at: "src/proxy.ts", expect: "layer" },
    { at: "src/app/[org]/layout.tsx", expect: null },
  ],
  "unplaced-file.ts": [
    { at: "src/lib/helpers.ts", expect: "layer" },
    { at: "src/ui/helpers.ts", expect: null },
  ],
  "outside-src.ts": [{ at: "src/features/fleet/reads.ts", expect: "layer" }],
  // A dot segment inside the alias resolves past the importer's own row; the
  // harness judges the normalized path, as it does for a relative specifier.
  "alias-dot-segments-feature.ts": [
    { at: "src/features/fleet/reads.ts", expect: "layer" },
  ],
  "alias-dot-segments-data.ts": [
    { at: "src/server/kernel.ts", expect: "layer" },
  ],
  // INV-22: test-only targets, each placed where the importer's row would
  // otherwise admit the edge.
  "feature-imports-builders.ts": [
    { at: "src/features/shell/probe.ts", expect: "layer" },
  ],
  "imports-viewer-testing.ts": [
    { at: "src/server/viewer.ts", expect: "layer" },
    { at: "src/features/shell/source.ts", expect: "layer" },
  ],
  // INV-02: the MINT token, importable by the viewer seam and its test helper alone.
  "imports-viewer-mint.ts": [
    { at: "src/server/viewer.ts", expect: null },
    { at: "src/server/viewer.testing.ts", expect: null },
    { at: "src/server/kernel.ts", expect: "layer" },
    { at: "src/features/shell/source.ts", expect: "layer" },
  ],
  "shell-client.ts": [{ at: "src/features/fleet/board.tsx", expect: null }],
  // #4162: the flyout's parked cards decide through Fleet's client entry.
  "fleet-client.ts": [
    { at: "src/features/shell/assistant-parked-approvals.tsx", expect: null },
  ],
  // #2953: Fleet's steer receipt opens the delivery report through Run's client entry.
  "run-client.ts": [{ at: "src/features/fleet/steer-fleet.tsx", expect: null }],
  "kernel-write-use-server.ts": [
    { at: "src/features/fleet/actions.ts", expect: null },
  ],
  "kernel-write-no-directive.ts": [
    { at: "src/features/fleet/actions.ts", expect: "layer" },
  ],
  // A read a person asks for, from a module that resolves its own viewer: the
  // Repositories page's on-demand reads (§2, the `features` row).
  "kernel-read-use-server.ts": [
    { at: "src/features/fleet/actions.ts", expect: null },
    { at: "src/data/live/runs.ts", expect: null },
  ],
  // Without the directive it is not an action, so it never resolved a viewer.
  "kernel-read-no-directive.ts": [
    { at: "src/features/fleet/reads.ts", expect: "layer" },
  ],
  // The third name the kernel seam lends the `features` row: a pure mapper, on
  // the same terms as the two calls.
  "read-to-action-result-use-server.ts": [
    { at: "src/features/shell/account-actions.ts", expect: null },
  ],
  "read-to-action-result-no-directive.ts": [
    { at: "src/features/shell/shell-data.ts", expect: "layer" },
  ],
  "kernel-types-from-feature.ts": [
    { at: "src/features/fleet/approvals.tsx", expect: null },
  ],
  "sse-from-feature.ts": [
    { at: "src/features/fleet/stream.ts", expect: "layer" },
    { at: "src/features/run/stream.ts", expect: null },
  ],
  // INV-21: the client boundary, read from the directive.
  "client-imports-server.tsx": [
    { at: "src/features/shell/switchers.tsx", expect: "client" },
  ],
  "client-imports-server-types.tsx": [
    { at: "src/features/shell/switchers.tsx", expect: null },
  ],
  "client-imports-data-source.tsx": [
    { at: "src/features/shell/switchers.tsx", expect: "client" },
  ],
  "client-imports-data-live.tsx": [
    { at: "src/features/shell/switchers.tsx", expect: "client" },
  ],
  "client-imports-feature-barrel.tsx": [
    { at: "src/features/shell/switchers.tsx", expect: "client" },
  ],
};

describe("import graph probes", () => {
  it("every probe file is placed", () => {
    expect(
      listFiles(PROBE_DIR).map((f) => f.slice(PROBE_DIR.length + 1)),
    ).toEqual(Object.keys(PROBES).sort());
  });

  for (const [probe, placements] of Object.entries(PROBES)) {
    for (const { at, expect: rule } of placements) {
      it(`${probe} at ${at} ${rule === null ? "passes" : `fails ${rule}`}`, () => {
        const source = readSource(`${PROBE_DIR}/${probe}`);
        const violations = violationsOf({ file: at, text: source.text });
        if (rule === null) {
          expect(violations).toEqual([]);
        } else {
          expect(rulesHit(violations), violations.join("\n")).toContain(rule);
        }
      });
    }
  }
});
