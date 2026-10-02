// The capture plan of the mockup parity audit (#4818): which app states
// capture.ts screenshots for each page of the registry, as whom, and at what
// address. CI-only audit tooling. It is pure, so plan.test.ts proves it with no
// browser, and capture.ts drives Chromium over what it returns.
//
// It mirrors the design capture in oxageninc/roadmap
// (tools/capture-design.mjs), so the design artifact and the app artifacts
// name the same states and the same files:
//
//   loaded         page.app.path as page.app.persona
//   role:<key>     the path as each persona in page.personas; anonymous has
//                  no session
//   denied         the path as guest, an organization Member outside the
//                  workspace, when the path names a workspace; else as the
//                  outsider, a member of another organization only
//   empty          the path with {ws} as the empty workspace, as
//                  page.app.persona, who holds the same role there as in core
//   signed-out     the path with no session
//   not-found      the path with its id placeholders as `no-such-id`
//   error          the path on the fault server, whose ClickHouse and Neo4j
//                  URLs point at closed ports
//   loading        the path over a throttled network, taken before it settles
//   <page state>   each state whose `app` field is { path, persona?, workspace? },
//                  where the one workspace hint the seed provides is `empty`
//
// Everything else is skipped with its reason, and the reason lands in the
// manifest, so a missing capture is never a silent one. So is a capture whose
// path keeps a placeholder the seed could not fill: no URL with a brace in it
// is ever opened.
import { z } from "zod";
import {
  type PersonaKey,
  type PersonasRecord,
  personaByKey,
  type Placeholder,
  PLACEHOLDERS,
} from "./personas";

// ── The registry ──────────────────────────────────────────────────────────

/** A page state's app address: `{ path, persona?, workspace? }`. */
const stateAppSchema = z.object({
  path: z.string().min(1),
  persona: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
});

/** The fields of one registry page the capture reads; the rest are dropped. */
const pageSchema = z.object({
  slug: z.string().min(1),
  app: z
    .object({
      path: z.string().min(1).optional(),
      persona: z.string().min(1).optional(),
      route: z.string().optional(),
    })
    .nullable()
    .optional(),
  checks: z.array(z.string()).default([]),
  personas: z.array(z.string()).default([]),
  plans: z.array(z.string()).default([]),
  states: z
    .array(z.object({ id: z.string().min(1), app: z.unknown().optional() }))
    .default([]),
});

/** `mockups/pages/pages.json` in oxageninc/roadmap, as far as the capture reads it. */
export const registrySchema = z.object({ pages: z.array(pageSchema) });
export type Registry = z.infer<typeof registrySchema>;
export type RegistryPage = z.infer<typeof pageSchema>;

/**
 * The pages to capture: every page, or the slugs named, in registry order. A
 * slug the registry lacks is an error, so a typo in a dispatch fails at once.
 */
export function selectPages(
  registry: Registry,
  only: readonly string[] | null,
): { pages: RegistryPage[]; unknown: string[] } {
  if (only === null) return { pages: registry.pages, unknown: [] };
  const wanted = new Set(only);
  return {
    pages: registry.pages.filter((page) => wanted.has(page.slug)),
    unknown: only.filter(
      (slug) => !registry.pages.some((page) => page.slug === slug),
    ),
  };
}

// ── Variants ──────────────────────────────────────────────────────────────

/** The three ways every state is taken, the design capture's three. */
export const VARIANTS = [
  { theme: "dark", viewport: "desktop", size: { width: 1440, height: 1000 } },
  { theme: "light", viewport: "desktop", size: { width: 1440, height: 1000 } },
  { theme: "dark", viewport: "phone", size: { width: 400, height: 860 } },
] as const;
export type Variant = (typeof VARIANTS)[number];

/** A variant's name as `--variants` spells it: `<theme>.<viewport>`. */
export function variantName(variant: Variant): string {
  return `${variant.theme}.${variant.viewport}`;
}

/**
 * The variants `--variants` names, comma-separated, or all three when it is
 * absent. Null when a name matches none, so the caller can refuse it.
 */
export function pickVariants(names: string | null): Variant[] | null {
  if (names === null) return [...VARIANTS];
  const wanted = names
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const picked = VARIANTS.filter((variant) =>
    wanted.includes(variantName(variant)),
  );
  return picked.length === wanted.length && picked.length > 0 ? picked : null;
}

/** `<state>.<theme>.<viewport>.png`, where a `:` in the state id becomes `-`. */
export function fileName(state: string, variant: Variant): string {
  return `${state.replace(/:/g, "-")}.${variant.theme}.${variant.viewport}.png`;
}

// ── The plan ──────────────────────────────────────────────────────────────

/** An overlay with no address: capture.ts opens it on the page beneath. */
export type OverlayKey = "command-menu" | "account" | "stella" | "new-workspace";

/** The registry pages the app draws as an overlay, keyed by slug. */
const OVERLAYS: Readonly<Record<string, OverlayKey>> = {
  "command-menu": "command-menu",
  account: "account",
  stella: "stella",
  "new-workspace": "new-workspace",
};

/** One screenshot to take, before its placeholders are filled. */
export type Capture = {
  readonly state: string;
  /** The registry path, placeholders and all. */
  readonly path: string;
  /** Who is signed in; `anonymous` means no session. */
  readonly persona: PersonaKey;
  /** `fault` is the second server, whose ClickHouse and Neo4j are unreachable. */
  readonly server: "app" | "fault";
  /** `loading` is taken over a throttled network before the page settles. */
  readonly mode: "settled" | "loading";
  /** `empty` puts the empty workspace in `{ws}`. */
  readonly workspace: "seeded" | "empty";
};

/** A state the capture does not take, with the reason the manifest records. */
export type Skip = { readonly state: string; readonly reason: string };

export type PagePlan = {
  readonly slug: string;
  /** The overlay each capture opens, or null for a page with an address. */
  readonly overlay: OverlayKey | null;
  /** Said once for the page in the manifest, such as an overlay with no opener. */
  readonly note: string | null;
  readonly captures: readonly Capture[];
  readonly skipped: readonly Skip[];
};

/**
 * Who `denied` signs in as. On a path that names a workspace it is guest, an
 * organization Member in no workspace, for whom the design draws "You cannot
 * see this workspace" and the app answers its workspace denied page. On any
 * other path it is the outsider, whom the app answers with its root
 * not-found page.
 */
function deniedViewer(path: string): PersonaKey {
  return path.includes("{ws}") ? "guest" : "outsider";
}

/** Workspace hints a page state can carry that the seed does not provide, and why. */
const UNSEEDED_HINTS: Readonly<Record<string, string>> = {
  "two-factor-required":
    "No seeded organization requires two-factor. No capability writes an organization's security policy, so the seed cannot set one.",
};

/** The design's default viewer, standing in when a page names no persona. */
const DEFAULT_VIEWER = "marcus";

/** What `not-found` puts where the path names a record. */
export const NOT_FOUND_ID = "no-such-id";

/** Checks the three variants cover, which are not states of their own. */
const VARIANT_CHECKS: ReadonlySet<string> = new Set([
  "loaded",
  "theme:dark",
  "theme:light",
  "phone",
]);

/** Checks the capture cannot take, and why. */
const SKIPPED_CHECKS: Readonly<Record<string, string>> = {
  partial:
    "One store failing while the rest answer needs a fault in that store alone. The fault server fails ClickHouse and Neo4j together, which is the error state.",
  "session-expired":
    "A session ending while the page is open is an interaction, not a capture.",
  "role-change":
    "A role granted or revoked while the page is open is an interaction, not a capture.",
  "action-failure":
    "A write that fails or loses the network is an interaction, not a capture.",
  keyboard: "Keyboard use is an interaction, not a capture.",
  "first-run":
    "Every seeded account belongs to an organization, so the first run before one exists cannot be reached.",
  suspended: "No suspended account is seeded.",
};

const PLAN_REASON =
  "The seed has one plan, Free, so no other plan can be captured.";

/** The first overlay hint in a registry route, such as `(Cmd+K)`. */
function overlayHint(route: string | undefined): string | null {
  const match = route === undefined ? null : /\(([^)]+)\)\s*$/.exec(route);
  return match?.[1] ?? null;
}

/** Every state the capture takes or skips for one page, in the manifest's order. */
export function planPage(page: RegistryPage): PagePlan {
  const path = page.app?.path;
  if (path === undefined) {
    return {
      slug: page.slug,
      overlay: null,
      note: null,
      captures: [],
      skipped: [
        {
          state: "loaded",
          reason: "The registry gives this page no app path.",
        },
      ],
    };
  }

  const captures: Capture[] = [];
  const skipped: Skip[] = [];
  const base = page.app?.persona ?? DEFAULT_VIEWER;

  /** Plan a capture as `key`, or skip it when personas.ts has no such persona. */
  const take = (
    state: string,
    key: string,
    address: Omit<Capture, "state" | "persona">,
  ): void => {
    const persona = personaByKey(key);
    if (persona === undefined) {
      skipped.push({ state, reason: `No seeded persona is named "${key}".` });
      return;
    }
    captures.push({ state, persona: persona.key, ...address });
  };
  const fields = (
    overrides: Partial<Omit<Capture, "state" | "persona">> = {},
  ) => ({
    path,
    server: "app" as const,
    mode: "settled" as const,
    workspace: "seeded" as const,
    ...overrides,
  });

  take("loaded", base, fields());
  for (const key of page.personas) take(`role:${key}`, key, fields());

  for (const check of page.checks) {
    if (VARIANT_CHECKS.has(check)) continue;
    const reason = SKIPPED_CHECKS[check];
    if (reason !== undefined) {
      skipped.push({ state: check, reason });
      continue;
    }
    switch (check) {
      case "denied":
        take("denied", deniedViewer(path), fields());
        break;
      case "signed-out":
        take("signed-out", "anonymous", fields());
        break;
      case "empty":
        if (path.includes("{ws}")) {
          take("empty", base, fields({ workspace: "empty" }));
        } else {
          skipped.push({
            state: "empty",
            reason:
              "The path names no workspace, so the empty workspace cannot show this state.",
          });
        }
        break;
      case "not-found": {
        const missingPath = notFoundPath(path);
        if (missingPath === null) {
          skipped.push({
            state: "not-found",
            reason: "The path names no record whose id could be replaced.",
          });
        } else {
          take("not-found", base, fields({ path: missingPath }));
        }
        break;
      }
      case "error":
        take("error", base, fields({ server: "fault" }));
        break;
      case "loading":
        take("loading", base, fields({ mode: "loading" }));
        break;
      default:
        skipped.push({
          state: check,
          reason: `The capture does not know the check "${check}".`,
        });
    }
  }

  for (const state of page.states) {
    const address = stateAppSchema.safeParse(state.app);
    if (!address.success) {
      skipped.push({
        state: state.id,
        reason: "The registry gives this state no app address.",
      });
      continue;
    }
    const { workspace } = address.data;
    if (workspace !== undefined && workspace !== "empty") {
      skipped.push({
        state: state.id,
        reason:
          UNSEEDED_HINTS[workspace] ??
          `The seed provides no workspace for the hint "${workspace}".`,
      });
      continue;
    }
    take(
      state.id,
      address.data.persona ?? base,
      fields({
        path: address.data.path,
        workspace: workspace === undefined ? "seeded" : "empty",
      }),
    );
  }

  for (const plan of page.plans) {
    skipped.push({ state: `plan:${plan}`, reason: PLAN_REASON });
  }

  const overlay = OVERLAYS[page.slug] ?? null;
  const hint = overlay === null ? overlayHint(page.app?.route) : null;
  return {
    slug: page.slug,
    overlay,
    note:
      hint === null
        ? null
        : `The app opens this page with "${hint}", and capture.ts has no opener for it, so each capture shows the page beneath.`,
    captures,
    skipped,
  };
}

// ── Placeholders ──────────────────────────────────────────────────────────

/** A placeholder is any braced name; one the seed cannot fill is reported. */
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Placeholders that name no record, which `not-found` leaves alone. */
const NON_ID_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "org",
  "ws",
  "step",
  "email",
]);

/** The placeholder with this name, or undefined for a name the registry does not define. */
function placeholderNamed(name: string): Placeholder | undefined {
  return PLACEHOLDERS.find((placeholder) => placeholder === name);
}

/** Every placeholder name in a path, in order, repeats kept. */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
}

/** A placeholder that names a record: a run, an agent, an invitation, and so on. */
function isIdPlaceholder(name: string): boolean {
  return !NON_ID_PLACEHOLDERS.has(name);
}

/**
 * The path with every id placeholder as `no-such-id`, the organization and
 * workspace left for `resolvePath`, or null when the path names no record.
 */
export function notFoundPath(template: string): string | null {
  if (!placeholdersIn(template).some(isIdPlaceholder)) return null;
  return template.replace(PLACEHOLDER, (whole: string, name: string) =>
    isIdPlaceholder(name) ? NOT_FOUND_ID : whole,
  );
}

export type Resolved =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      /** Placeholders with no value, each named once. */
      readonly missing: readonly string[];
      /** True when a brace is left that names no placeholder. */
      readonly stray: boolean;
    };

/**
 * The path with every placeholder filled, or why it cannot be opened: the
 * names that have no value, or a brace left over. Values are URL-encoded, so a
 * brace in the result can only come from the template.
 */
export function resolvePath(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
): Resolved {
  const missing: string[] = [];
  const path = template.replace(PLACEHOLDER, (whole: string, name: string) => {
    const value = values[name];
    if (value === undefined) {
      missing.push(name);
      return whole;
    }
    return encodeURIComponent(value);
  });
  if (missing.length > 0) {
    return { ok: false, missing: [...new Set(missing)], stray: false };
  }
  if (/[{}]/.test(path)) return { ok: false, missing: [], stray: true };
  return { ok: true, path };
}

/**
 * The placeholder values one capture reads: the seed's, the run from
 * `seed.json`, and the empty workspace in `{ws}` for an `empty` capture.
 */
export function valuesFor(
  capture: Capture,
  record: PersonasRecord,
  runPublicId: string,
): Record<string, string | undefined> {
  return {
    ...record.values,
    run: runPublicId,
    ...(capture.workspace === "empty"
      ? { ws: record.emptyWorkspaceSlug }
      : {}),
  };
}

/**
 * Why a capture's path cannot be opened: each placeholder with no value, with
 * the seed's reason for it when the seed gave one, or a stray brace.
 */
export function unresolvedReason(
  failure: Extract<Resolved, { ok: false }>,
  record: PersonasRecord,
): string {
  if (failure.stray) {
    return "The path keeps a brace that names no placeholder, so it is not opened.";
  }
  return failure.missing
    .map((name) => {
      const placeholder = placeholderNamed(name);
      const why =
        placeholder === undefined ? undefined : record.missing[placeholder];
      return why === undefined
        ? `{${name}} has no seeded value.`
        : `{${name}} has no seeded value. ${why}`;
    })
    .join(" ");
}
