// The §2 layer matrix and platform-package allowlist of ARCHITECTURE.md as data,
// consumed by import-graph.test.ts. Paths are posix and relative to `src/`
// without extension; a directory import ends in `/index` (parse.ts).
//
// Readings this file settles, each recorded in the PR that made it (WL-01
// unless named):
// - The named rows of the platform allowlist add to the base row ("everything
//   else under src/"): kernel.ts reports to telemetry (§3.2 steps 0 and 6), so
//   the base row's `captureError` must reach it.
// - `@oxagen/ui` is the shared component library, not a platform package: it
//   touches no store and no kernel, and the root layout and sidebar import it,
//   so it is outside the platform set.
// - `src/i18n/**` has no row in §2; it is treated as a leaf like `src/shared`
//   (it may import only itself). The one edge into it, `app/layout.tsx` →
//   `@/i18n/catalogs`, is a baseline entry for WL-33's root-layout rewrite.
import type { ImportEdge } from "./parse";

export type Directive = "use client" | "use server" | null;

export type Importer = {
  /** Posix path relative to `src/`, without extension. */
  readonly file: string;
  readonly directive: Directive;
};

type LayerName =
  | "app"
  | "features"
  | "ui"
  | "vocabulary"
  | "ports"
  | "source"
  | "live"
  | "server"
  | "shared"
  | "proxy"
  | "i18n";

const under = (file: string, dir: string): boolean =>
  file.startsWith(`${dir}/`);

const featurePage = (file: string): string | null =>
  under(file, "features") ? (file.split("/")[1] ?? null) : null;

const isFeatureBarrel = (target: string): boolean =>
  /^features\/[^/]+\/index$/.test(target);

/** Every binding of the edge is in `names`; a side-effect import or a namespace binds more than that. */
const onlyNames = (edge: ImportEdge, names: readonly string[]): boolean =>
  edge.names.length > 0 && edge.names.every((name) => names.includes(name));

/**
 * The `"use server"` modules that read a `DataSource` port directly (ADR-167).
 * A page reads through the port when the route renders and hands the rows
 * down. A record picker reads when a person opens it, inside a form, and the
 * port's answer is already mapped and checked against its view model, so
 * reaching the port stops the picker's actions from copying eight mappers into
 * a feature lane.
 *
 * The module resolves its own viewer first (INV-19, actions.test.ts) and
 * answers in `ActionResult`. The list is exact: a second module needs its own
 * reason here and in ADR-167.
 */
const PORT_READING_ACTIONS: readonly string[] = [
  "features/shell/choice-actions",
];

const isVocabulary = (target: string): boolean =>
  target === "data/read" ||
  under(target, "data/contracts") ||
  target === "data/unrecorded";

/** Which §2 row a production module falls under; null for a file the matrix does not place. */
function layerOf(file: string): LayerName | null {
  if (under(file, "app")) return "app";
  if (under(file, "features")) return "features";
  if (under(file, "ui")) return "ui";
  if (isVocabulary(file)) return "vocabulary";
  if (file === "data/ports") return "ports";
  if (file === "data/source") return "source";
  if (under(file, "data/live")) return "live";
  if (under(file, "server")) return "server";
  if (under(file, "shared")) return "shared";
  if (file === "proxy") return "proxy";
  if (under(file, "i18n")) return "i18n";
  return null;
}

/**
 * The "May import (internal)" column of §2, one predicate per row. A file the
 * matrix does not place may import nothing internal: every edge out of it is a
 * violation until the file is deleted or moved into a row.
 */
const ALLOWED: Record<
  LayerName,
  (from: Importer, target: string, edge: ImportEdge) => boolean
> = {
  app: (_from, target) =>
    isFeatureBarrel(target) ||
    target === "server/viewer" ||
    target === "data/source" ||
    under(target, "ui") ||
    under(target, "shared"),
  features: (from, target, edge) => {
    const page = featurePage(from.file);
    if (page !== null && under(target, `features/${page}`)) return true;
    if (isFeatureBarrel(target) || target === "features/shell/client")
      return true;
    if (under(target, "ui") || under(target, "shared")) return true;
    if (isVocabulary(target) || target === "data/ports") return true;
    if (target === "data/source")
      return (
        PORT_READING_ACTIONS.includes(from.file) &&
        from.directive === "use server"
      );
    if (target === "server/viewer" || target === "server/session") return true;
    // `server/viewer-zone` has no row here on purpose. A write that places a
    // calendar day a person picked needs the zone they picked it in, and
    // `viewerTimeZone` answers it, but features reach it through the
    // `@/server/viewer` re-export they already may import (viewer.ts) rather
    // than through a second named seam. Admitting the module here would permit
    // the direct import that seam exists to avoid.
    // `kernelWrite`, `kernelRead` and `readToActionResult`, only from a
    // "use server" module; their types from anywhere. The read half is ADR-089.
    //
    // `readToActionResult` completes that list rather than widening it. It is a
    // pure mapper from a `Read` to an `ActionResult` — a switch over the four
    // `Read` variants — and reaches neither the kernel nor a store. It lives in
    // kernel.ts because it is the other end of the encoding `toRead` produces,
    // and the two must be read together. An action that reads has to carry its
    // `Read` across into INV-19's shape, so it is part of the same seam surface
    // the two named calls are: it was written out by hand in
    // features/shell/account-actions.ts and the Workspace settings actions (now
    // features/repositories/actions.ts), and
    // both copies collapsed every error to `unavailable`.
    //
    // `kernelRead` is here because a read that must happen ON DEMAND has
    // nowhere else to live. A page or layout read goes through a DataSource
    // port (§3.3) and is made when the route renders. The Repositories page's
    // reads are live calls to GitHub (`list_installation_repositories`,
    // `get_repository_tree`), one per bound repository, and some happen only
    // when a person opens a picker or a dialog. Making them all at render
    // would hold the whole page on the slowest of them. So the page asks for
    // each record when it needs it, through a "use server" module
    // that resolves its own viewer, exactly as a write does. A read from a
    // module with no directive is still refused, and so is a read that is not
    // preceded by `requireViewer` (INV-19, actions.test.ts).
    if (target === "server/kernel") {
      return (
        edge.typeOnly ||
        (from.directive === "use server" &&
          onlyNames(edge, ["kernelWrite", "kernelRead", "readToActionResult"]))
      );
    }
    // The stream handler alone (§3.5).
    if (target === "server/sse") return from.file === "features/run/stream";
    return false;
  },
  // The "(types)" qualifiers of §2 are read literally: a value import of a
  // zod schema from `@/data/contracts/*` or of `@/data/read` is a layer violation
  // from `ui`, as is a value import of `@/server/viewer` from `ports`.
  ui: (_from, target, edge) =>
    under(target, "ui") ||
    target === "data/unrecorded" ||
    (isVocabulary(target) && edge.typeOnly) ||
    under(target, "shared"),
  vocabulary: (_from, target) => isVocabulary(target),
  ports: (_from, target, edge) =>
    target === "data/read" ||
    under(target, "data/contracts") ||
    (target === "server/viewer" && edge.typeOnly),
  source: (_from, target) => under(target, "data/live"),
  live: (_from, target) =>
    isVocabulary(target) ||
    target === "data/ports" ||
    target === "server/kernel" ||
    under(target, "data/live"),
  server: (_from, target) =>
    target === "data/read" ||
    under(target, "shared") ||
    under(target, "server"),
  shared: (_from, target) => under(target, "shared"),
  proxy: (_from, target) => under(target, "shared"),
  i18n: (_from, target) => under(target, "i18n"),
};

/**
 * INV-22: a module that exists for tests. No §2 row admits an edge to one, so
 * the `features` row's same-feature grant and the `server` row's own-directory
 * grant stop at `shell.builders` and `viewer.testing`. Test files are not
 * judged as importers (parse.ts `isTestOnly`), which is what leaves them free
 * to import these.
 */
export const testOnlyTarget = (target: string): boolean =>
  /\.builders$/.test(target) || target === "server/viewer.testing";

/** INV-02: the module that exports the MINT token. */
export const MINT_MODULE = "server/viewer-mint";

/** INV-02: the only modules that may hold the MINT token, test files included. */
export const MINT_IMPORTERS: readonly string[] = [
  "server/viewer",
  "server/viewer.testing",
];

/** INV-07: does the §2 row of `from` admit an internal edge to `target`? */
export function layerAllows(
  from: Importer,
  target: string,
  edge: ImportEdge,
): boolean {
  if (target === MINT_MODULE) return MINT_IMPORTERS.includes(from.file);
  if (testOnlyTarget(target)) return false;
  const layer = layerOf(from.file);
  return layer !== null && ALLOWED[layer](from, target, edge);
}

/** INV-21: a "use client" module never reaches these, whatever its row says. */
export function clientBoundaryRefuses(
  target: string,
  edge: ImportEdge,
): boolean {
  if (under(target, "server")) return !edge.typeOnly;
  return (
    target === "data/source" ||
    under(target, "data/live") ||
    isFeatureBarrel(target)
  );
}

// --- Platform-package allowlist (INV-03, INV-05) -----------------------------

/** A specifier the allowlist governs: every `@oxagen/*` entry except the UI library, plus the ORM. */
export function isPlatformSpecifier(specifier: string): boolean {
  if (specifier === "@oxagen/ui" || specifier.startsWith("@oxagen/ui/")) {
    return false;
  }
  return (
    specifier.startsWith("@oxagen/") ||
    specifier === "drizzle-orm" ||
    specifier.startsWith("drizzle-orm/")
  );
}

/** Specifier patterns: exact, or `<prefix>/*` for any subpath except `index` (the barrel through the export map). */
const matches = (pattern: string, specifier: string): boolean => {
  if (!pattern.endsWith("/*")) return pattern === specifier;
  const prefix = pattern.slice(0, -1);
  return (
    specifier.startsWith(prefix) &&
    specifier.length > prefix.length &&
    specifier.slice(prefix.length) !== "index"
  );
};

/** Rows keyed by file relative to APP_DIR (the module rows of the §2 table). */
const PLATFORM_ROWS: Readonly<Record<string, readonly string[]>> = {
  "src/server/kernel.ts": [
    "@oxagen/oxagen",
    "@oxagen/oxagen/kernel",
    "@oxagen/oxagen/registry",
    "@oxagen/oxagen/types",
    "@oxagen/handlers/register",
    "@oxagen/agent/register",
  ],
  "src/server/session.ts": ["@oxagen/auth", "@oxagen/auth/*"],
  "src/features/auth/auth-client.ts": ["@oxagen/auth/client"],
  // The shell's user menu and Account dialog make Better Auth calls of their
  // own (sign out, the session list and its revoke, fresh recovery codes). The
  // auth barrel is server-only and a feature's internals are not importable
  // across lanes, so the shell keeps its own browser seam to the same client.
  "src/features/shell/session-client.ts": ["@oxagen/auth/client"],
  // The shell's blob seam. A data export's archive is a private object, so the
  // bytes are streamed by a route rather than linked. §2 leaves that route and
  // its handler nowhere to get an object reader — the `app` row admits
  // `server/viewer` and no other `server/*`, and the `features` row admits the
  // viewer, session and kernel seams alone — so a `src/server/blob.ts` would
  // have had to widen two layer rows to be reachable. The seam sits in the
  // feature instead, as `session-client.ts` and `features/audit/filters.ts` do,
  // and exports one narrow read: nothing downstream can write, delete or reach
  // a second store through it.
  "src/features/shell/export-storage.ts": ["@oxagen/storage"],
  // The emitted security event types the Audit filter offers (#2528, #3097):
  // a pure leaf package with no store and no kernel.
  "src/features/audit/filters.ts": ["@oxagen/compliance"],
  "src/server/tenancy-lookups.ts": ["@oxagen/database", "drizzle-orm"],
  "instrumentation.ts": [
    "@oxagen/oxagen/kernel",
    "@oxagen/iam",
    "@oxagen/billing",
    "@oxagen/plugins",
    "@oxagen/rules",
    "@oxagen/database/data-plane",
  ],
};

/**
 * Bindings a row admits from a specifier its module list does not name whole
 * (#3048). `instrumentation.ts` is the process bootstrap: it wires the tracer,
 * the RLS connection guard and the security event emitter, as
 * `apps/api/src/bootstrap.ts` and `apps/mcp/src/middleware.ts` do. Any other
 * binding from these specifiers, a namespace or a side-effect import is refused.
 */
const PLATFORM_NAMED_ROWS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  // Skill-only parsing subpath has no kernel, handler, or contract-registry import.
  "src/features/create/skill-file.ts": {
    "@oxagen/oxagen/skill-frontmatter": ["readSkillFrontmatter"],
  },
  "src/shared/skill-source-identity.ts": {
    "@oxagen/oxagen/skill-frontmatter": [
      "readSkillFrontmatter",
      "renameSkillFrontmatterName",
    ],
  },
  // The org gate's Require SSO lookup asks one question of billing: does the
  // organisation's plan include SSO (ADR-145). The same single tier read the
  // kernel's gates use. The sign-up allowance read keys billing.plans by the
  // Free plan's slug, which billing owns. Nothing else from the package.
  "src/server/tenancy-lookups.ts": {
    "@oxagen/billing": ["canAccessSSO", "FREE_PLAN_SLUG", "resolveOrgTier"],
  },
  // Browser controls read the shared ceiling without loading the contract registry:
  // Steer the fleet caps its text at the limit dispatch_command enforces.
  "src/features/fleet/steer-fleet.tsx": {
    "@oxagen/oxagen/tacho/command-limits": ["STEER_TEXT_MAX"],
  },
  "src/ui/command-failure.ts": {
    "@oxagen/oxagen/tacho/command-limits": ["COMMAND_REASON_MAX"],
  },
  // The record wizard shows the label and file name a slug will get, using
  // the same pure functions the publish handler runs, so the preview matches.
  // Both files check a slug against the pattern the contract enforces.
  "src/features/create/record-wizard.tsx": {
    "@oxagen/oxagen/context-record-label": [
      "CONTEXT_RECORD_LINEAGE",
      "contextRecordLabel",
      "contextRecordSlug",
    ],
  },
  "src/features/create/record-file.ts": {
    "@oxagen/oxagen/context-record-label": ["CONTEXT_RECORD_LINEAGE"],
  },
  "instrumentation.ts": {
    "@oxagen/telemetry": ["initTracer", "recordSecurityEvent"],
    "@oxagen/database/security": ["makeSecurityEventInserter"],
    "@oxagen/database": ["assertRlsConnectionSafe"],
  },
  // ADR-108: the mandate detail mapper falls back to the same single-location
  // legacy-kind guess parseMandateRow uses, for the one case that function
  // cannot cover (a ledger row drawing a measure the mandate's current
  // limits no longer list). Named-only, matching every other seam here.
  "src/data/live/mappers/mandates.ts": {
    "@oxagen/rules": ["legacyMeasureKindGuess"],
  },
};

/** The base row, "everything else under src/": contract declarations, and one telemetry export. */
const BASE_SPECIFIERS = ["@oxagen/oxagen/contracts/*"] as const;
const BASE_NAMED: Readonly<Record<string, readonly string[]>> = {
  "@oxagen/telemetry": ["captureError"],
};

/** Does the allowlist admit `edge` from the file at `appFile` (relative to APP_DIR)? */
export function platformAllows(appFile: string, edge: ImportEdge): boolean {
  const { specifier } = edge;
  const row = PLATFORM_ROWS[appFile] ?? [];
  if ([...row, ...BASE_SPECIFIERS].some((p) => matches(p, specifier))) {
    return true;
  }
  return onlyNames(edge, [
    ...(BASE_NAMED[specifier] ?? []),
    ...(PLATFORM_NAMED_ROWS[appFile]?.[specifier] ?? []),
  ]);
}
