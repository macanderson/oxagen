// The capture plan of the mockup parity audit (#4818), proven without a
// browser: which states each registry page yields, as whom, at what address,
// and the reason for every state it skips. capture.ts only drives Chromium
// over this plan, so these rules are the part a CI run cannot show at a glance.
import { describe, expect, it } from "vitest";
import {
  type Capture,
  fileName,
  NOT_FOUND_ID,
  notFoundPath,
  pickVariants,
  placeholdersIn,
  planPage,
  type RegistryPage,
  registrySchema,
  resolvePath,
  selectPages,
  unresolvedReason,
  VARIANTS,
  valuesFor,
} from "./plan";
import type { PersonasRecord } from "./personas";

/** One registry page, with the registry's defaults filled in. */
function page(fields: Record<string, unknown>): RegistryPage {
  const parsed = registrySchema.parse({ pages: [fields] }).pages[0];
  if (parsed === undefined) throw new Error("the registry parsed no page");
  return parsed;
}

const RECORD: PersonasRecord = {
  schema: 1,
  orgSlug: "e2e-org",
  workspaceSlug: "core",
  emptyWorkspaceSlug: "empty",
  outsideOrgSlug: "e2e-outside",
  outsideWorkspaceSlug: "home",
  values: {
    org: "e2e-org",
    ws: "core",
    agent: "e2e-agent",
    token: "invi_open",
    email: "marcus@e2e.oxagen.test",
  },
  missing: { mandate: "No mandate is seeded." },
  personas: {},
};

const BASE: Omit<Capture, "state" | "persona" | "path"> = {
  server: "app",
  mode: "settled",
  workspace: "seeded",
};

describe("planPage", () => {
  it("plans a workspace page state by state, in the manifest's order", () => {
    const plan = planPage(
      page({
        slug: "run",
        app: { path: "/{org}/{ws}/runs/{run}", persona: "marcus" },
        checks: [
          "loaded",
          "loading",
          "partial",
          "error",
          "denied",
          "signed-out",
          "theme:dark",
          "theme:light",
          "phone",
          "not-found",
          "empty",
          "keyboard",
        ],
        personas: ["marcus", "priya", "guest", "outsider", "anonymous"],
        states: [
          { id: "replay", app: { path: "/{org}/{ws}/runs/{run}?replay=1" } },
        ],
      }),
    );
    const path = "/{org}/{ws}/runs/{run}";
    expect(plan.overlay).toBeNull();
    expect(plan.note).toBeNull();
    expect(plan.captures).toEqual([
      { ...BASE, state: "loaded", persona: "marcus", path },
      { ...BASE, state: "role:marcus", persona: "marcus", path },
      { ...BASE, state: "role:priya", persona: "priya", path },
      { ...BASE, state: "role:guest", persona: "guest", path },
      { ...BASE, state: "role:outsider", persona: "outsider", path },
      { ...BASE, state: "role:anonymous", persona: "anonymous", path },
      { ...BASE, state: "loading", persona: "marcus", path, mode: "loading" },
      { ...BASE, state: "error", persona: "marcus", path, server: "fault" },
      { ...BASE, state: "denied", persona: "guest", path },
      { ...BASE, state: "signed-out", persona: "anonymous", path },
      {
        ...BASE,
        state: "not-found",
        persona: "marcus",
        path: `/{org}/{ws}/runs/${NOT_FOUND_ID}`,
      },
      {
        ...BASE,
        state: "empty",
        persona: "marcus",
        path,
        workspace: "empty",
      },
      {
        ...BASE,
        state: "replay",
        persona: "marcus",
        path: "/{org}/{ws}/runs/{run}?replay=1",
      },
    ]);
    expect(plan.skipped.map((skip) => skip.state)).toEqual([
      "partial",
      "keyboard",
    ]);
    for (const skip of plan.skipped) expect(skip.reason).not.toBe("");
  });

  it("signs in as the outsider for denied on a path that names no workspace", () => {
    const plan = planPage(
      page({
        slug: "org-people",
        app: { path: "/{org}", persona: "priya" },
        checks: ["denied"],
      }),
    );
    expect(plan.captures.find((c) => c.state === "denied")?.persona).toBe(
      "outsider",
    );
  });

  it("skips every interaction, a plan, first-run, and suspended with a reason", () => {
    const plan = planPage(
      page({
        slug: "work",
        app: { path: "/{org}/{ws}/work", persona: "marcus" },
        checks: [
          "partial",
          "session-expired",
          "role-change",
          "action-failure",
          "keyboard",
          "first-run",
          "suspended",
        ],
        plans: ["build"],
      }),
    );
    expect(plan.captures.map((c) => c.state)).toEqual(["loaded"]);
    expect(plan.skipped.map((skip) => skip.state)).toEqual([
      "partial",
      "session-expired",
      "role-change",
      "action-failure",
      "keyboard",
      "first-run",
      "suspended",
      "plan:build",
    ]);
    expect(
      plan.skipped.find((skip) => skip.state === "role-change")?.reason,
    ).toMatch(/interaction, not a capture/);
    expect(
      plan.skipped.find((skip) => skip.state === "plan:build")?.reason,
    ).toMatch(/one plan/);
  });

  it("skips a check it does not know, rather than dropping it", () => {
    const plan = planPage(
      page({
        slug: "x",
        app: { path: "/{org}", persona: "priya" },
        checks: ["hover"],
      }),
    );
    expect(plan.skipped).toEqual([
      { state: "hover", reason: 'The capture does not know the check "hover".' },
    ]);
  });

  it("skips empty when the path names no workspace, and not-found when it names no record", () => {
    const plan = planPage(
      page({
        slug: "org-workspaces",
        app: { path: "/{org}?tab=workspaces", persona: "priya" },
        checks: ["empty", "not-found"],
      }),
    );
    expect(plan.captures.map((c) => c.state)).toEqual(["loaded"]);
    expect(plan.skipped.map((skip) => skip.state)).toEqual([
      "empty",
      "not-found",
    ]);
  });

  it("skips a persona personas.ts lacks, with its key in the reason", () => {
    const plan = planPage(
      page({
        slug: "x",
        app: { path: "/{org}", persona: "priya" },
        personas: ["nobody"],
      }),
    );
    expect(plan.skipped).toEqual([
      { state: "role:nobody", reason: 'No seeded persona is named "nobody".' },
    ]);
  });

  it("takes a page state's persona and the empty workspace hint, and skips any other hint", () => {
    const plan = planPage(
      page({
        slug: "onboarding",
        app: { path: "/welcome/{org}/{ws}/wrap", persona: "priya" },
        states: [
          {
            id: "no-agent",
            app: { path: "/welcome/{org}/{ws}/wrap", workspace: "empty" },
          },
          {
            id: "enroll-required",
            app: {
              path: "/two-factor?enroll=required",
              persona: "priya",
              workspace: "two-factor-required",
            },
          },
          {
            id: "odd-hint",
            app: { path: "/{org}", workspace: "archived" },
          },
          { id: "design-only", app: null },
          { id: "no-app-field" },
          { id: "as-marcus", app: { path: "/{org}", persona: "marcus" } },
        ],
      }),
    );
    expect(plan.captures).toEqual([
      {
        ...BASE,
        state: "loaded",
        persona: "priya",
        path: "/welcome/{org}/{ws}/wrap",
      },
      {
        ...BASE,
        state: "no-agent",
        persona: "priya",
        path: "/welcome/{org}/{ws}/wrap",
        workspace: "empty",
      },
      { ...BASE, state: "as-marcus", persona: "marcus", path: "/{org}" },
    ]);
    expect(plan.skipped.map((skip) => skip.state)).toEqual([
      "enroll-required",
      "odd-hint",
      "design-only",
      "no-app-field",
    ]);
    const [twoFactor, odd, designOnly, noField] = plan.skipped;
    expect(twoFactor?.reason).toMatch(/requires two-factor/);
    expect(odd?.reason).toBe(
      'The seed provides no workspace for the hint "archived".',
    );
    expect(designOnly?.reason).toBe(
      "The registry gives this state no app address.",
    );
    expect(noField?.reason).toBe(designOnly?.reason);
  });

  it("names the overlay each capture opens for the four overlay pages", () => {
    for (const slug of ["command-menu", "account", "stella", "new-workspace"]) {
      const plan = planPage(
        page({
          slug,
          app: { path: "/{org}/{ws}", persona: "marcus", route: "x (y)" },
        }),
      );
      expect(plan.overlay).toBe(slug);
      expect(plan.note).toBeNull();
    }
  });

  it("notes an overlay route it has no opener for, and captures the page beneath", () => {
    const plan = planPage(
      page({
        slug: "flyout",
        app: {
          path: "/{org}/{ws}",
          persona: "marcus",
          route: "/{org}/{ws} (bell)",
        },
      }),
    );
    expect(plan.overlay).toBeNull();
    expect(plan.note).toMatch(/"bell".*no opener/);
    expect(plan.captures.map((c) => c.state)).toEqual(["loaded"]);
  });

  it("skips a page with no app path, and falls back to marcus when it names no persona", () => {
    expect(planPage(page({ slug: "gone", app: null })).skipped).toEqual([
      { state: "loaded", reason: "The registry gives this page no app path." },
    ]);
    expect(
      planPage(page({ slug: "bare", app: { path: "/{org}" } })).captures[0]
        ?.persona,
    ).toBe("marcus");
  });
});

describe("placeholders", () => {
  it("lists every braced name, camel case included", () => {
    expect(placeholdersIn("/invite/{expiredToken}?to={email}&ws={ws}")).toEqual(
      ["expiredToken", "email", "ws"],
    );
  });

  it("fills every placeholder and encodes the value", () => {
    expect(
      resolvePath("/verify?email={email}", { email: "a+b@e2e.oxagen.test" }),
    ).toEqual({ ok: true, path: "/verify?email=a%2Bb%40e2e.oxagen.test" });
    expect(
      resolvePath("/{org}/{ws}/agents/{agent}", RECORD.values),
    ).toEqual({ ok: true, path: "/e2e-org/core/agents/e2e-agent" });
  });

  it("names each placeholder with no value once, and opens nothing", () => {
    expect(
      resolvePath("/{org}/{mandate}/{mandate}/{declinedToken}", RECORD.values),
    ).toEqual({
      ok: false,
      missing: ["mandate", "declinedToken"],
      stray: false,
    });
  });

  it("refuses a path that keeps a brace naming no placeholder", () => {
    expect(resolvePath("/{org}/x}", RECORD.values)).toEqual({
      ok: false,
      missing: [],
      stray: true,
    });
    expect(resolvePath("/{org}/{", RECORD.values)).toEqual({
      ok: false,
      missing: [],
      stray: true,
    });
  });

  it("gives the seed's reason for a missing value, and a plain one otherwise", () => {
    expect(
      unresolvedReason(
        { ok: false, missing: ["mandate", "tool", "nonsense"], stray: false },
        RECORD,
      ),
    ).toBe(
      "{mandate} has no seeded value. No mandate is seeded. {tool} has no seeded value. {nonsense} has no seeded value.",
    );
    expect(
      unresolvedReason({ ok: false, missing: [], stray: true }, RECORD),
    ).toMatch(/brace/);
  });

  it("puts no-such-id in every record placeholder, and leaves org, ws, step, and email", () => {
    expect(notFoundPath("/{org}/{ws}/spend/operator/{operator}")).toBe(
      `/{org}/{ws}/spend/operator/${NOT_FOUND_ID}`,
    );
    expect(notFoundPath("/invite/{token}")).toBe(`/invite/${NOT_FOUND_ID}`);
    expect(notFoundPath("/{org}/{ws}/register/{step}")).toBeNull();
    expect(notFoundPath("/verify?email={email}")).toBeNull();
    expect(notFoundPath("/{org}/audit")).toBeNull();
  });

  it("reads the run from seed.json and puts the empty workspace in {ws} for an empty capture", () => {
    const capture: Capture = {
      ...BASE,
      state: "loaded",
      persona: "marcus",
      path: "/{org}/{ws}/runs/{run}",
    };
    expect(valuesFor(capture, RECORD, "arun_1")).toMatchObject({
      ws: "core",
      run: "arun_1",
    });
    expect(
      valuesFor({ ...capture, workspace: "empty" }, RECORD, "arun_1"),
    ).toMatchObject({ ws: "empty", run: "arun_1" });
  });
});

describe("pages and variants", () => {
  const registry = registrySchema.parse({
    pages: [{ slug: "a" }, { slug: "b" }, { slug: "c" }],
  });

  it("selects every page, or the named ones in registry order, and reports an unknown slug", () => {
    expect(selectPages(registry, null).pages.map((p) => p.slug)).toEqual([
      "a",
      "b",
      "c",
    ]);
    const some = selectPages(registry, ["c", "a", "zz"]);
    expect(some.pages.map((p) => p.slug)).toEqual(["a", "c"]);
    expect(some.unknown).toEqual(["zz"]);
  });

  it("defaults a page's lists when the registry leaves them out", () => {
    expect(registry.pages[0]).toEqual({
      slug: "a",
      checks: [],
      personas: [],
      plans: [],
      states: [],
    });
  });

  it("takes all three variants by default, the named ones on request, and refuses a name it lacks", () => {
    expect(pickVariants(null)).toEqual([...VARIANTS]);
    expect(pickVariants("dark.phone, light.desktop")?.map((v) => v.viewport))
      .toEqual(["desktop", "phone"]);
    expect(pickVariants("dark.watch")).toBeNull();
    expect(pickVariants("")).toBeNull();
  });

  it("names a file by state, theme, and viewport, with a colon as a hyphen", () => {
    const [darkDesktop, , darkPhone] = VARIANTS;
    expect(fileName("role:amara", darkDesktop)).toBe(
      "role-amara.dark.desktop.png",
    );
    expect(fileName("loaded", darkPhone)).toBe("loaded.dark.phone.png");
  });
});
