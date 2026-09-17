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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
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

async function renderApiKeys(read: Read<ApiKey[]>, orgRole: OrgRole = "owner") {
  const ctx = wsCtx(orgRole);
  const { source, calls } = orgSource({ apiKeys: read });
  const view = render(
    <IntlProvider>
      {await ApiKeys({ ctx, source, workspaces: readOk(CHOICES) })}
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

describe("API keys tabs", () => {
  it("link People, Roles and API keys by URL, API keys marked as the current page", async () => {
    await renderApiKeys(readOk([live]));
    const tabs = screen.getByRole("navigation", { name: "Organization" });
    const people = within(tabs).getByRole("link", { name: "People" });
    const keys = within(tabs).getByRole("link", { name: "API keys" });
    expect(people).toHaveAttribute("href", "/acme");
    expect(people).not.toHaveAttribute("aria-current");
    expect(keys).toHaveAttribute("href", "/acme/api-keys");
    expect(keys).toHaveAttribute("aria-current", "page");
  });

  it("carry Roles, the same strip every other Organization page shows", async () => {
    // A hand-rolled two-entry strip here left Roles unreachable from this page
    // the moment Roles was added (#3110). The shared component owns the set.
    await renderApiKeys(readOk([live]));
    const tabs = screen.getByRole("navigation", { name: "Organization" });
    expect(within(tabs).getByRole("link", { name: "Roles" })).toHaveAttribute(
      "href",
      "/acme/roles",
    );
  });
});

describe("ok", () => {
  it("lists each key with its name, prefix, creation, last use and expiry", async () => {
    await renderApiKeys(readOk([live, unused]));
    const row = rowFor(live);
    expect(row).toHaveTextContent("CI runner");
    expect(row).toHaveTextContent("ox_liveliveli");
    expect(row).toHaveTextContent("Sep 13, 2026");
    expect(row).toHaveTextContent("Sep 14, 2026");
    expect(within(row).getByText("Sep 13, 2026")).toHaveAttribute(
      "datetime",
      "2026-09-13T10:00:00.000Z",
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
    await renderApiKeys(readOk([live, expired, revoked]));
    expect(
      within(rowFor(live)).getByText("live").closest("[data-status]"),
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
    await renderApiKeys(readOk([live, revoked]));
    expect(
      screen.getByText(
        "A key acts as the person who created it, in this workspace: on the API, MCP and the CLI it can do what that person can do here, and no more.",
      ),
    ).toBeInTheDocument();
    expect(keysTable()).not.toHaveTextContent(/secret|hash/i);
  });

  it("carries rotate and revoke on a live key, revoke alone on an expired one and neither on a revoked one", async () => {
    await renderApiKeys(readOk([live, expired, revoked]));
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
      within(rowFor(serviceOwned)).getByText("live").closest("[data-status]"),
    ).toHaveAttribute("data-status", "live");
  });

  it("offers the create control above the table, closed until it is opened", async () => {
    await renderApiKeys(readOk([live]));
    expect(
      screen.getByRole("button", { name: "Create a key" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("create-api-key")).toBeNull();
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
      screen.getByRole("button", { name: "Create a key" }),
    ).toBeInTheDocument();
  });
});

describe("the workspace a key names", () => {
  it("reads the keys of the workspace in scope, through a WsCtx and never an OrgCtx", async () => {
    const ctx = wsCtx();
    const { source, calls } = orgSource({ apiKeys: readOk([live]) });
    render(
      <IntlProvider>
        {await ApiKeys({ ctx, source, workspaces: readOk(CHOICES) })}
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

  it("keeps an archived workspace in the picker, named as archived, so its live keys stay revocable", async () => {
    // archive_workspace records archived_at and nothing else, and resolveApiKey
    // never consults it: a key in an archived workspace keeps authenticating.
    // Off the picker it would be a working credential nobody can reach.
    const ctx = wsCtx();
    const { source } = orgSource({ apiKeys: readOk([live]) });
    const view = render(
      <IntlProvider>
        {
          await ApiKeys({
            ctx,
            source,
            workspaces: readOk(list(core, growth, sunset)),
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
        {await ApiKeys({ ctx, source, workspaces: readOk(list(sunset)) })}
      </IntlProvider>,
    );
    expect(screen.queryByRole("button", { name: "Create a key" })).toBeNull();
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
      screen.getByRole("button", { name: "Create a key" }),
    ).toBeInTheDocument();
  });

  it("reads no key at all when the viewer may enter no workspace (negative)", async () => {
    const ctx = unsafeMint(OrgCtx, { ...ORG_FIELDS, orgRole: "owner" });
    const { source, calls } = orgSource({});
    const view = render(
      <IntlProvider>
        {await ApiKeys({ ctx, source, workspaces: readOk(list()) })}
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
    expect(
      screen.getByRole("navigation", { name: "Organization" }),
    ).toBeInTheDocument();
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
