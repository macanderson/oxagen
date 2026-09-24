// @vitest-environment jsdom
// Organization › API keys over org.workspaces and org.apiKeys: the tabs, the
// workspace picker, the keys table in the ok state with an unused key, an
// expired key, a revoked key and a key with no expiry, the empty line, and the
// denied, pending-approval and error states that replace the table. Every state
// is checked with axe.
//
// The page names a workspace (ADR-073). It reads keys through a WsCtx and never
// through an OrgCtx: `auth.api_keys` is policy class `standard`, so the org-only
// sentinel lists no key that exists and mints one into a workspace that does
// not. With no workspace the viewer may enter, the section says so and reads
// nothing.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKey, Workspace, WorkspaceList } from "@/data/contracts/org";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { apiKey, orgSource, workspaceRow } from "./organization.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));
vi.mock("./api-key-actions", () => ({
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx, WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { ApiKeys, chooseWorkspace } = await import("./api-keys");
const { API_KEYS_PAGE, pageOfKeys, parseApiKeysView } = await import(
  "./api-keys-view"
);
/** `API_KEYS_PAGE` and the figures around it, as the pager prints them. */
const PAGE = String(API_KEYS_PAGE);
const nth = (n: number) => String(API_KEYS_PAGE + n);

/** The view a request with no query asks for: the unrevoked keys, first page. */
const ACTIVE = parseApiKeysView({});
/** The same page with the revoked keys on it. */
const ALL = parseApiKeysView({ show: "all" });

afterEach(() => {
  cleanup();
});

const ORG_FIELDS = {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
} as const;

/** `list_workspaces` answers the organization's whole set, in one object. */
const list = (...workspaces: Workspace[]): WorkspaceList => ({ workspaces });

const core = workspaceRow({ slug: "core-platform", name: "Core platform" });
const growth = workspaceRow({
  id: "wrk_1q2w3e4r5t6y7u8i9o0p1a",
  slug: "growth",
  name: "Growth",
});
const sunset = workspaceRow({
  id: "wrk_9z8y7x6w5v4t3s2r1q0p9n",
  slug: "sunset",
  name: "Sunset",
  archivedAt: "2026-09-01T00:00:00.000Z",
});
/** A workspace of this organization the viewer holds no membership in. */
const foreign = workspaceRow({
  id: "wrk_4f3e2d1c0b9a8z7y6x5w4v",
  slug: "finance",
  name: "Finance",
  role: null,
});
const CHOICES = list(core, growth);

/** The workspace ctx the page resolves once it has picked a workspace. */
function wsCtx(orgRole: OrgRole = "owner") {
  return unsafeMint(WsCtx, {
    ...ORG_FIELDS,
    orgRole,
    workspaceId: "7a000000-0000-4000-8000-0000000000c3",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole: "member",
  });
}

async function renderApiKeys(
  read: Read<ApiKey[]>,
  orgRole: OrgRole = "owner",
  asked = ACTIVE,
) {
  const ctx = wsCtx(orgRole);
  const { source, calls } = orgSource({ apiKeys: read });
  const view = render(
    <IntlProvider>
      {
        await ApiKeys({
          ctx,
          source,
          workspaces: readOk(CHOICES),
          view: asked,
        })
      }
    </IntlProvider>,
  );
  expect(calls.apiKeys).toEqual([[ctx]]);
  expect(calls.members).toEqual([]);
  await expectNoAxe(view.container);
  return view;
}

const live = apiKey();
const unused = apiKey({
  id: "aky_0a1b2c3d4e5f6g7h8j9k0m",
  name: "Release bot",
  prefix: "ox_relrelrelr",
  lastUsedAt: null,
  expiresAt: "2099-03-01T23:59:59.999Z",
});
const serviceOwned = apiKey({
  id: "aky_1q2w3e4r5t6y7u8i9o0p1a",
  name: "build-01 host key",
  prefix: "ox_tachotacho",
  lastUsedAt: null,
  rotatable: false,
});
const expired = apiKey({
  id: "aky_4f3e2d1c0b9a8z7y6x5w4v",
  name: "Old runner",
  prefix: "ox_expexpexpe",
  lastUsedAt: null,
  expiresAt: "2020-01-01T23:59:59.999Z",
});
const revoked = apiKey({
  id: "aky_9z8y7x6w5v4t3s2r1q0p9n",
  name: "Laptop",
  prefix: "ox_oldoldoldo",
  lastUsedAt: null,
  revokedAt: "2026-09-10T08:00:00.000Z",
});

const keysTable = () => screen.getByRole("table", { name: "API keys" });
const rowFor = (key: ApiKey) => {
  const row = keysTable().querySelector<HTMLElement>(
    `[data-api-key="${key.id}"]`,
  );
  if (row === null) throw new Error(`no row for ${key.id}`);
  return row;
};

describe("the API keys panel", () => {
  it("carries the caption, the store badge and Create key", async () => {
    await renderApiKeys(readOk([live]));
    const panel = screen.getByRole("region", { name: "API keys" });
    expect(panel).toHaveTextContent(
      "each key acts as the person who created it",
    );
    expect(
      within(panel).getByText("postgres · iam + vault"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: "Create key" }),
    ).toBeInTheDocument();
  });

  it("names the columns in the design's order", async () => {
    await renderApiKeys(readOk([live]));
    expect(
      within(keysTable())
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "Name",
      "Principal",
      "Grants",
      "Created by",
      "Last used",
      "Actions 30d",
      "Expires",
      "",
    ]);
  });

  it("says not recorded for the principal, the grants, the creator and the 30-day count rather than a guess", async () => {
    await renderApiKeys(readOk([live]));
    expect(rowFor(live).querySelectorAll("[data-not-recorded]")).toHaveLength(
      4,
    );
  });

  it("lists the surfaces a key reaches, with four oxagen command lines", async () => {
    await renderApiKeys(readOk([live]));
    const surfaces = screen.getByRole("region", {
      name: "Surfaces this reaches",
    });
    expect(surfaces).toHaveTextContent("one agent tool contract");
    expect(surfaces).toHaveTextContent(
      "Parity is checked by the manifest gate.",
    );
    const lines = within(surfaces)
      .getByTestId("api-keys-cli")
      .textContent.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("$ oxagen login --org acme");
  });
});

describe("ok", () => {
  it("lists each key with its name, masked prefix, last use and expiry", async () => {
    await renderApiKeys(readOk([live, unused]));
    const row = rowFor(live);
    expect(row).toHaveTextContent("CI runner");
    expect(row).toHaveTextContent("ox_liveliveli…");
    expect(within(row).getByText("Sep 14, 2026")).toHaveAttribute(
      "datetime",
      "2026-09-14T11:30:00.000Z",
    );
    expect(rowFor(unused)).toHaveTextContent("Mar 1, 2099");
  });

  it("says a key was never used and never expires rather than inventing a date", async () => {
    await renderApiKeys(readOk([live, unused]));
    expect(rowFor(unused)).toHaveTextContent("Never used");
    expect(rowFor(live)).toHaveTextContent("Never");
    expect(rowFor(live)).not.toHaveTextContent("Never used");
  });

  it("marks a key live, expired or revoked, as a dot and a word", async () => {
    // Shown under the All filter, the only place a revoked row appears.
    await renderApiKeys(readOk([live, expired, revoked]), "owner", ALL);
    expect(
      within(rowFor(live)).getByText("active").closest("[data-status]"),
    ).toHaveAttribute("data-status", "live");
    // resolveApiKey refuses an expired key, so the roster must not call it live.
    expect(
      within(rowFor(expired)).getByText("expired").closest("[data-status]"),
    ).toHaveAttribute("data-status", "expired");
    expect(
      within(rowFor(revoked)).getByText("revoked").closest("[data-status]"),
    ).toHaveAttribute("data-status", "revoked");
  });

  it("says what a key can do, and lists no secret and no hash (negative)", async () => {
    await renderApiKeys(readOk([live, revoked]), "owner", ALL);
    expect(
      screen.getByText(
        "A key is shown once, at creation, and never again. Until keys carry grants of their own, a key acts as the person who created it, in its workspace. Revoking a key ends its access at the next call.",
      ),
    ).toBeInTheDocument();
    expect(keysTable()).not.toHaveTextContent(/secret|hash/i);
  });

  it("carries rotate and revoke on a live key, revoke alone on an expired one and neither on a revoked one", async () => {
    await renderApiKeys(readOk([live, expired, revoked]), "owner", ALL);
    const labels = (key: ApiKey) =>
      within(rowFor(key))
        .getAllByRole("button")
        .map((button) => button.textContent);
    expect(labels(live)).toEqual(["Rotate", "Revoke"]);
    // Rotation gives the replacement the rotated key's expiry, so rotating an
    // expired key would show a secret that is already unusable.
    expect(labels(expired)).toEqual(["Revoke"]);
    expect(within(rowFor(revoked)).queryAllByRole("button")).toEqual([]);
  });

  it("offers Revoke alone on a key an enrollment owns, whose rotation the handler refuses (negative)", async () => {
    // rotate_api_key denies a key carrying a server-owned scope purpose, and
    // list_api_keys reports it, so the row offers no control that can only fail.
    await renderApiKeys(readOk([live, serviceOwned]));
    expect(
      within(rowFor(serviceOwned))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Revoke"]);
    expect(
      within(rowFor(serviceOwned))
        .getByText("never used")
        .closest("[data-status]"),
    ).toHaveAttribute("data-status", "never-used");
  });

  it("offers the create control above the table, closed until it is opened", async () => {
    await renderApiKeys(readOk([live]));
    expect(
      screen.getByRole("button", { name: "Create key" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("create-api-key")).toBeNull();
  });
});

/** `n` live keys, newest first, each with an id and a prefix of its own. */
function manyKeys(n: number): ApiKey[] {
  return Array.from({ length: n }, (_, i) =>
    apiKey({
      id: `aky_page${String(i).padStart(18, "0")}`,
      name: `Runner ${String(i)}`,
      prefix: `ox_p${String(i).padStart(9, "0")}`,
    }),
  );
}

/** `n` revoked keys, so the default filter has something to hide. */
function manyRevoked(n: number): ApiKey[] {
  return Array.from({ length: n }, (_, i) =>
    apiKey({
      id: `aky_gone${String(i).padStart(18, "0")}`,
      name: `Gone ${String(i)}`,
      prefix: `ox_g${String(i).padStart(9, "0")}`,
      revokedAt: "2026-09-10T08:00:00.000Z",
    }),
  );
}

const filterNav = () => screen.getByRole("navigation", { name: "Which keys" });
const pagerNav = () =>
  screen.getByRole("navigation", { name: "Pages of API keys" });
const rowIds = () =>
  Array.from(keysTable().querySelectorAll("[data-api-key]")).map((row) =>
    row.getAttribute("data-api-key"),
  );

describe("the ended keys the page hides", () => {
  it("opens on the active keys, with no revoked or expired row on the table", async () => {
    // A revoked or expired key authenticates nothing, so it is a record of a
    // key, not a key, and it does not push the active ones below it.
    await renderApiKeys(readOk([live, expired, revoked]));
    expect(rowIds()).toEqual([live.id]);
    expect(keysTable()).not.toHaveTextContent("Laptop");
  });

  it("files a key that expired before the read under All, judged at the read instant", async () => {
    // Expiry is judged at the instant the roster was read, the clock the
    // server render shares with every later render, so no row leaves the
    // table while it is open.
    await renderApiKeys(readOk([expired]));
    expect(
      document.querySelector("[data-state=empty-filtered]"),
    ).toHaveTextContent(
      "Every key in this workspace has been revoked or has expired. Choose All to see it.",
    );
    expect(parseApiKeysView({}).show).toBe("active");
  });

  it("marks Active as the current filter and offers All, counting what it holds back", async () => {
    const view = await renderApiKeys(readOk([live, revoked]));
    const active = within(filterNav()).getByRole("link", {
      name: "Active",
    });
    const all = within(filterNav()).getByRole("link", {
      name: "All (1 ended)",
    });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(active).toHaveAttribute(
      "href",
      "/acme/api-keys?workspace=core-platform",
    );
    expect(all).not.toHaveAttribute("aria-current");
    expect(all).toHaveAttribute(
      "href",
      "/acme/api-keys?workspace=core-platform&show=all",
    );
    await expectNoAxe(view.container);
  });

  it("names All plainly when there is nothing revoked to count", async () => {
    await renderApiKeys(readOk([live]));
    expect(
      within(filterNav()).getByRole("link", { name: "All" }),
    ).toBeInTheDocument();
  });

  it("shows the revoked keys, with their revocation dates, once All is asked for", async () => {
    await renderApiKeys(readOk([live, revoked]), "owner", ALL);
    expect(rowIds()).toEqual([live.id, revoked.id]);
    expect(
      within(filterNav()).getByRole("link", { name: "All (1 ended)" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(rowFor(revoked)).getByText("revoked").closest("[data-status]"),
    ).toHaveAttribute("data-status", "revoked");
  });

  it("names the filter Active and lists no row whose badge says otherwise (negative)", async () => {
    // A filter called Active over a row whose own status reads expired would
    // be the page contradicting itself, so Active keeps only live keys.
    await renderApiKeys(readOk([live, expired, revoked]));
    expect(
      within(filterNav()).getByRole("link", { name: "Active" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(filterNav()).queryByRole("link", { name: "Not revoked" }),
    ).toBeNull();
    expect(keysTable().querySelector('[data-status="expired"]')).toBeNull();
    expect(keysTable().querySelector('[data-status="revoked"]')).toBeNull();
  });

  it("gives the filter links a 44px target on a phone", async () => {
    await renderApiKeys(readOk([live, revoked]));
    for (const link of within(filterNav()).getAllByRole("link")) {
      expect(link).toHaveAttribute("data-touch-target");
      expect(link.className).toContain("max-md:min-h-11");
    }
  });

  it("falls back to the active keys for a filter it does not understand (negative)", () => {
    // A query value the page cannot read falls back rather than failing the
    // page, and the fallback is the one that hides revoked keys.
    expect(parseApiKeysView({ show: "everything" }).show).toBe("active");
    expect(parseApiKeysView({ show: ["all", "active"] }).show).toBe("all");
    expect(parseApiKeysView({}).show).toBe("active");
  });
});

describe("empty", () => {
  it("says the organization holds no keys, and still offers the first one", async () => {
    await renderApiKeys(readOk([]));
    expect(
      screen.getByText("This workspace has no API keys."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create key" }),
    ).toBeInTheDocument();
  });

  it("distinguishes a workspace with no keys from one whose keys are all revoked", async () => {
    // "This workspace has no API keys" over a workspace holding three revoked
    // ones is a lie the filter would be telling on the page's behalf.
    const view = await renderApiKeys(readOk(manyRevoked(3)));
    const line = screen.getByText(
      /Every key in this workspace has been revoked/,
    );
    expect(line).toHaveAttribute("data-state", "empty-filtered");
    expect(line).toHaveTextContent("Choose All to see them");
    expect(screen.queryByRole("table")).toBeNull();
    await expectNoAxe(view.container);
  });

  it("asks for the one hidden key in the singular", async () => {
    await renderApiKeys(readOk([revoked]));
    expect(screen.getByText(/Choose All to see it\./)).toBeInTheDocument();
  });

  it("says the workspace has no keys when All is asked for and there are none", async () => {
    await renderApiKeys(readOk([]), "owner", ALL);
    expect(
      screen.getByText("This workspace has no API keys."),
    ).toBeInTheDocument();
  });
});

describe("paging a roster larger than a page", () => {
  it("shows the range and one page, with no Previous or Next, while one page holds the roster (negative)", async () => {
    await renderApiKeys(readOk(manyKeys(API_KEYS_PAGE)));
    expect(rowIds()).toHaveLength(API_KEYS_PAGE);
    expect(pagerNav()).toHaveTextContent(`1–${PAGE} of ${PAGE}`);
    expect(
      within(pagerNav())
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["1"]);
  });

  it("offers the design's Rows choices and carries the choice in the URL", async () => {
    await renderApiKeys(readOk(manyKeys(API_KEYS_PAGE + 5)));
    const rowsSelect = screen.getByLabelText("Rows");
    expect(
      within(rowsSelect)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["5", "10", "25", "50", "All"]);
    await userEvent.selectOptions(rowsSelect, "25");
    expect(router.push).toHaveBeenCalledWith(
      "/acme/api-keys?workspace=core-platform&rows=25",
    );
  });

  it("shows every key on one page when Rows is All", async () => {
    const keys = manyKeys(API_KEYS_PAGE + 5);
    await renderApiKeys(readOk(keys), "owner", { ...ACTIVE, rows: 0 });
    expect(rowIds()).toHaveLength(keys.length);
    expect(parseApiKeysView({ rows: "all" }).rows).toBe(0);
    expect(parseApiKeysView({ rows: "7" }).rows).toBe(API_KEYS_PAGE);
  });

  it("numbers the pages and marks the current one", async () => {
    await renderApiKeys(readOk(manyKeys(API_KEYS_PAGE + 5)));
    const one = within(pagerNav()).getByRole("link", { name: "1" });
    const two = within(pagerNav()).getByRole("link", { name: "2" });
    expect(one).toHaveAttribute("aria-current", "page");
    expect(two).toHaveAttribute(
      "href",
      `/acme/api-keys?workspace=core-platform&offset=${PAGE}`,
    );
  });

  // 20 seconds, not the 5-second default. This is the only test in the file
  // that runs axe over a FULL page — twenty rows, each with its own Rotate and
  // Revoke, plus the pager — and axe's cost grows with the node count, so it
  // routinely ran past 5s on a loaded CI runner and failed as a timeout on
  // pull requests that had not touched this feature at all. The accessibility
  // assertion is the one worth keeping here (a full page with a pager is
  // exactly where a11y breaks), so the budget moves rather than the check.
  it("cuts the roster at API_KEYS_PAGE rows and offers the next page", async () => {
    const keys = manyKeys(API_KEYS_PAGE + 5);
    const view = await renderApiKeys(readOk(keys));
    expect(rowIds()).toEqual(keys.slice(0, API_KEYS_PAGE).map((k) => k.id));
    expect(pagerNav()).toHaveTextContent(`1–${PAGE} of ${nth(5)}`);
    const next = within(pagerNav()).getByRole("link", { name: "Next" });
    expect(next).toHaveAttribute(
      "href",
      `/acme/api-keys?workspace=core-platform&offset=${PAGE}`,
    );
    expect(
      within(pagerNav()).queryByRole("link", { name: "Previous" }),
    ).toBeNull();
    await expectNoAxe(view.container);
  }, 20_000);

  it("shows the last page's rows and the way back, with no Next beyond the end", async () => {
    const keys = manyKeys(API_KEYS_PAGE + 5);
    await renderApiKeys(readOk(keys), "owner", {
      ...ACTIVE,
      offset: API_KEYS_PAGE,
    });
    expect(rowIds()).toEqual(keys.slice(API_KEYS_PAGE).map((k) => k.id));
    expect(pagerNav()).toHaveTextContent(`${nth(1)}–${nth(5)} of ${nth(5)}`);
    expect(
      within(pagerNav()).getByRole("link", { name: "Previous" }),
    ).toHaveAttribute("href", "/acme/api-keys?workspace=core-platform");
    expect(within(pagerNav()).queryByRole("link", { name: "Next" })).toBeNull();
  });

  it("carries the filter through the pager, so a page of All stays All", async () => {
    const keys = [...manyKeys(API_KEYS_PAGE), ...manyRevoked(5)];
    await renderApiKeys(readOk(keys), "owner", ALL);
    expect(
      within(pagerNav()).getByRole("link", { name: "Next" }),
    ).toHaveAttribute(
      "href",
      `/acme/api-keys?workspace=core-platform&show=all&offset=${PAGE}`,
    );
  });

  it("pages the filtered roster, not the read: hidden keys take up no page", async () => {
    // 5 live keys buried under 20 revoked ones is one page of Active, not two.
    const keys = [...manyRevoked(API_KEYS_PAGE), ...manyKeys(5)];
    await renderApiKeys(readOk(keys));
    expect(rowIds()).toHaveLength(5);
    expect(pagerNav()).toHaveTextContent("1–5 of 5");
    expect(within(pagerNav()).queryByRole("link", { name: "Next" })).toBeNull();
  });

  it("clamps an offset past the end onto the last page that exists (negative)", async () => {
    // Revoking the last key on the last page, or narrowing the filter from a
    // deep page, otherwise answers with an empty table and no way back except
    // editing the URL.
    const keys = manyKeys(API_KEYS_PAGE + 5);
    await renderApiKeys(readOk(keys), "owner", {
      ...ACTIVE,
      offset: API_KEYS_PAGE * 9,
    });
    expect(rowIds()).toEqual(keys.slice(API_KEYS_PAGE).map((k) => k.id));
    expect(pagerNav()).toHaveTextContent(`${nth(1)}–${nth(5)} of ${nth(5)}`);
  });

  it("starts a page on a page boundary, so no two pages repeat a row (negative)", async () => {
    // The query string is shareable and hand-editable. `?offset=1` would show
    // rows 2 to 21 while Previous, at offset 0, shows rows 1 to 20 -- the two
    // pages repeating 19 rows, with no sequence of clicks ever reaching a
    // boundary again.
    const keys = manyKeys(API_KEYS_PAGE + 5);
    await renderApiKeys(readOk(keys), "owner", { ...ACTIVE, offset: 1 });
    expect(rowIds()).toEqual(keys.slice(0, API_KEYS_PAGE).map((k) => k.id));
    expect(pagerNav()).toHaveTextContent(`1\u2013${PAGE} of ${nth(5)}`);
    expect(
      within(pagerNav()).queryByRole("link", { name: "Previous" }),
    ).toBeNull();
  });

  it("aligns an unaligned offset down, never up, so no row is skipped", () => {
    const keys = manyKeys(API_KEYS_PAGE * 3);
    expect(pageOfKeys(keys, 1).offset).toBe(0);
    expect(pageOfKeys(keys, API_KEYS_PAGE - 1).offset).toBe(0);
    expect(pageOfKeys(keys, API_KEYS_PAGE).offset).toBe(API_KEYS_PAGE);
    expect(pageOfKeys(keys, API_KEYS_PAGE + 1).offset).toBe(API_KEYS_PAGE);
  });

  it("falls back to the first page for an offset it does not understand (negative)", () => {
    expect(parseApiKeysView({ offset: "20" }).offset).toBe(20);
    expect(parseApiKeysView({ offset: "-1" }).offset).toBe(0);
    expect(parseApiKeysView({ offset: "020" }).offset).toBe(0);
    expect(parseApiKeysView({ offset: "1e3" }).offset).toBe(0);
    expect(parseApiKeysView({}).offset).toBe(0);
  });

  it("reads an offset far past any real roster rather than resetting it to the first page (negative)", () => {
    // The bound is what a double holds exactly, not a guess at how many keys a
    // workspace may have. A ceiling of the latter kind fails the wrong way: an
    // offset above it falls back to 0, so Next on the last page of a roster
    // past the ceiling would jump to the first page instead. `pageOfKeys`
    // clamps a too-large offset onto the last page that exists, which is where
    // an offset beyond the roster is supposed to land.
    expect(parseApiKeysView({ offset: "9999999999" }).offset).toBe(9999999999);
    expect(pageOfKeys(manyKeys(3), 9999999999).offset).toBe(0);
    // Past what a double holds exactly, the parse would round — and a rounded
    // offset is a silently different page — so it falls back instead.
    expect(parseApiKeysView({ offset: "9007199254740993" }).offset).toBe(0);
    expect(parseApiKeysView({ offset: "99999999999999999999" }).offset).toBe(0);
  });
});

describe("the workspace a key names", () => {
  it("reads the keys of the workspace in scope, through a WsCtx and never an OrgCtx", async () => {
    const ctx = wsCtx();
    const { source, calls } = orgSource({ apiKeys: readOk([live]) });
    render(
      <IntlProvider>
        {
          await ApiKeys({
            ctx,
            source,
            workspaces: readOk(CHOICES),
            view: ACTIVE,
          })
        }
      </IntlProvider>,
    );
    expect(calls.apiKeys).toEqual([[ctx]]);
    expect(WsCtx.is(calls.apiKeys[0]?.[0])).toBe(true);
  });

  it("links every workspace the viewer may enter and marks the one in scope", async () => {
    await renderApiKeys(readOk([live]));
    const picker = screen.getByRole("navigation", { name: "Workspace" });
    const here = within(picker).getByRole("link", { name: "Core platform" });
    const other = within(picker).getByRole("link", { name: "Growth" });
    expect(here).toHaveAttribute(
      "href",
      "/acme/api-keys?workspace=core-platform",
    );
    expect(here).toHaveAttribute("aria-current", "page");
    expect(other).toHaveAttribute("href", "/acme/api-keys?workspace=growth");
    expect(other).not.toHaveAttribute("aria-current");
  });

  it("carries the filter to the next workspace and drops the page", async () => {
    // A person who asked to see revoked keys asked about keys. The page is the
    // other way round: page four of this roster says nothing about the next.
    await renderApiKeys(readOk([live]), "owner", {
      ...ALL,
      offset: API_KEYS_PAGE,
    });
    const picker = screen.getByRole("navigation", { name: "Workspace" });
    expect(
      within(picker).getByRole("link", { name: "Growth" }),
    ).toHaveAttribute("href", "/acme/api-keys?workspace=growth&show=all");
  });

  it("keeps an archived workspace in the picker, named as archived, so its live keys stay revocable", async () => {
    // A key in an archived workspace stops authenticating (ADR-104) but is not
    // revoked: restoring the workspace restores it. Off the picker it would be
    // a live credential nobody can revoke for good.
    const ctx = wsCtx();
    const { source } = orgSource({ apiKeys: readOk([live]) });
    const view = render(
      <IntlProvider>
        {
          await ApiKeys({
            ctx,
            source,
            workspaces: readOk(list(core, growth, sunset)),
            view: ACTIVE,
          })
        }
      </IntlProvider>,
    );
    const picker = screen.getByRole("navigation", { name: "Workspace" });
    expect(
      within(picker).getByRole("link", { name: "Sunset (archived)" }),
    ).toHaveAttribute("href", "/acme/api-keys?workspace=sunset");
    await expectNoAxe(view.container);
  });

  it("offers no workspace the viewer is not a member of, which would 404 (negative)", async () => {
    // `list_workspaces` answers the organization's whole set, with `role` null
    // for a workspace the viewer does not belong to, and viewer resolution
    // answers exactly those with not_found (INV-15). A link to one would be a
    // link to a page that cannot open.
    const ctx = wsCtx();
    const { source } = orgSource({ apiKeys: readOk([live]) });
    render(
      <IntlProvider>
        {
          await ApiKeys({
            ctx,
            source,
            workspaces: readOk(list(core, foreign)),
            view: ACTIVE,
          })
        }
      </IntlProvider>,
    );
    const picker = screen.getByRole("navigation", { name: "Workspace" });
    expect(within(picker).queryByRole("link", { name: "Finance" })).toBeNull();
    expect(
      within(picker).getByRole("link", { name: "Core platform" }),
    ).toBeInTheDocument();
    expect(chooseWorkspace(readOk(list(foreign)), "finance")).toBeNull();
  });

  it("says so on the page when the workspace in scope is archived", async () => {
    const ctx = unsafeMint(WsCtx, {
      ...ORG_FIELDS,
      orgRole: "owner",
      workspaceId: "7a000000-0000-4000-8000-0000000000c4",
      wsSlug: "sunset",
      wsName: "Sunset",
      wsRole: "member",
    });
    const { source } = orgSource({ apiKeys: readOk([live]) });
    render(
      <IntlProvider>
        {
          await ApiKeys({
            ctx,
            source,
            workspaces: readOk(list(sunset)),
            view: ACTIVE,
          })
        }
      </IntlProvider>,
    );
    expect(screen.getByTestId("api-keys-archived-workspace")).toHaveTextContent(
      "Its keys still authenticate, so they are listed here until they are revoked — but no new key is issued into it.",
    );
  });

  it("offers no Create in an archived workspace, and says the page will not issue one (negative)", async () => {
    // The page lists an archived workspace's keys for one reason and says so:
    // they still authenticate and have to be revocable. Minting another there
    // is the opposite of winding down, and `create_api_key` refuses it
    // (conflict / workspace_archived) — this is the courtesy above it.
    const ctx = unsafeMint(WsCtx, {
      ...ORG_FIELDS,
      orgRole: "owner",
      workspaceId: "7a000000-0000-4000-8000-0000000000c4",
      wsSlug: "sunset",
      wsName: "Sunset",
      wsRole: "member",
    });
    const { source } = orgSource({ apiKeys: readOk([live]) });
    const view = render(
      <IntlProvider>
        {
          await ApiKeys({
            ctx,
            source,
            workspaces: readOk(list(sunset)),
            view: ACTIVE,
          })
        }
      </IntlProvider>,
    );
    expect(screen.queryByRole("button", { name: "Create key" })).toBeNull();
    expect(screen.getByTestId("api-keys-archived-workspace")).toHaveTextContent(
      "no new key is issued into it",
    );
    // The keys themselves are still listed, with Revoke and no Rotate: a
    // rotation mints fresh material for a workspace meant to be inert, while
    // revoking is what these keys are listed for.
    expect(keysTable()).toBeInTheDocument();
    expect(
      within(rowFor(live))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Revoke"]);
    await expectNoAxe(view.container);
  });

  it("offers Create in a workspace still in use", async () => {
    await renderApiKeys(readOk([live]));
    expect(
      screen.getByRole("button", { name: "Create key" }),
    ).toBeInTheDocument();
  });

  it("reads no key at all when the viewer may enter no workspace (negative)", async () => {
    const ctx = unsafeMint(OrgCtx, { ...ORG_FIELDS, orgRole: "owner" });
    const { source, calls } = orgSource({});
    const view = render(
      <IntlProvider>
        {
          await ApiKeys({
            ctx,
            source,
            workspaces: readOk(list()),
            view: ACTIVE,
          })
        }
      </IntlProvider>,
    );
    expect(calls.apiKeys).toEqual([]);
    expect(screen.getByTestId("api-keys-no-workspace")).toHaveTextContent(
      "A key is issued into one workspace and acts only there.",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    await expectNoAxe(view.container);
  });

  it("reads no key when the workspaces themselves could not be read (negative)", async () => {
    const ctx = unsafeMint(OrgCtx, { ...ORG_FIELDS, orgRole: "owner" });
    const { source, calls } = orgSource({});
    const view = render(
      <IntlProvider>
        {
          await ApiKeys({
            ctx,
            source,
            workspaces: readError("control_plane_unavailable", 503),
            view: ACTIVE,
          })
        }
      </IntlProvider>,
    );
    expect(calls.apiKeys).toEqual([]);
    expect(screen.getByTestId("api-keys-error")).toHaveTextContent(
      "503 control_plane_unavailable",
    );
    expect(screen.queryByRole("table")).toBeNull();
    await expectNoAxe(view.container);
  });
});

describe("chooseWorkspace", () => {
  it("takes the workspace the URL names, archived or not", () => {
    expect(chooseWorkspace(readOk(list(core, growth, sunset)), "sunset")).toBe(
      "sunset",
    );
  });

  it("opens on a workspace still in use when the URL names none", () => {
    expect(chooseWorkspace(readOk(list(sunset, core, growth)), undefined)).toBe(
      "core-platform",
    );
  });

  it("falls back to an archived workspace when every workspace is archived", () => {
    expect(chooseWorkspace(readOk(list(sunset)), undefined)).toBe("sunset");
  });

  it("names no workspace when the read failed or listed none (negative)", () => {
    expect(chooseWorkspace(readOk(list()), undefined)).toBeNull();
    expect(
      chooseWorkspace(readError("control_plane_unavailable", 503), "growth"),
    ).toBeNull();
  });
});

describe("a read that did not list", () => {
  it("denied: a Member viewer sees their role and the permission needed, and no keys (negative)", async () => {
    await renderApiKeys(
      { ok: false, reason: "denied", permission: "org.admin" },
      "member",
    );
    const panel = screen.getByTestId("api-keys-denied");
    expect(panel).toHaveTextContent(
      "You cannot see this organization’s API keys",
    );
    expect(panel).toHaveTextContent("Signed in as Member. Needed: org.admin.");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("pending approval: names the access request it waits on, and no keys (negative)", async () => {
    await renderApiKeys({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "areq_5t6u7v8w",
    });
    expect(screen.getByTestId("api-keys-pending")).toHaveTextContent(
      "Access request areq_5t6u7v8w is waiting for an owner’s decision.",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("error: names the status and code, and no keys (negative)", async () => {
    await renderApiKeys(readError("control_plane_unavailable", 503));
    const panel = screen.getByTestId("api-keys-error");
    expect(panel).toHaveTextContent("API keys could not be loaded");
    expect(panel).toHaveTextContent("503 control_plane_unavailable");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
