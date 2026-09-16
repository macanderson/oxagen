// @vitest-environment jsdom
// Organization › API keys over org.apiKeys: the tabs, the keys table in the ok
// state with an unused key, a revoked key and a key with no expiry, the empty
// line, and the denied, pending-approval and error states that replace the
// table. Every state is checked with axe. No secret, no hash and no create,
// rotate or revoke control renders: this page reads.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKey } from "@/data/contracts/org";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { apiKey, orgSource } from "./organization.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { ApiKeys } = await import("./api-keys");

afterEach(() => {
  cleanup();
});

async function renderApiKeys(read: Read<ApiKey[]>, orgRole: OrgRole = "owner") {
  const ctx = unsafeMint(OrgCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
  });
  const { source, calls } = orgSource({ apiKeys: read });
  const view = render(
    <IntlProvider>{await ApiKeys({ ctx, source })}</IntlProvider>,
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
  expiresAt: "2027-03-01T00:00:00.000Z",
});
const revoked = apiKey({
  id: "aky_9z8y7x6w5v4t3s2r1q0p9n",
  name: "Laptop",
  prefix: "ox_oldoldoldo",
  lastUsedAt: null,
  revokedAt: "2026-09-10T08:00:00.000Z",
});
// Never revoked, but its expiry is behind us: the platform already refuses to
// authenticate it (`expiresAt IS NULL OR expiresAt > now()` in tacho-host.ts
// and telemetry.stella.ingest.ts), so the page must not call it live.
const expired = apiKey({
  id: "aky_1a2b3c4d5e6f7g8h9j0k1m",
  name: "Old CI runner",
  prefix: "ox_expexpexpe",
  lastUsedAt: null,
  expiresAt: "2026-01-04T00:00:00.000Z",
});
// Revocation is a decision and outranks the clock: an expiry behind us does not
// turn a revoked key into an expired one.
const revokedAndExpired = apiKey({
  id: "aky_2b3c4d5e6f7g8h9j0k1m2n",
  name: "Retired bot",
  prefix: "ox_retretretr",
  lastUsedAt: null,
  expiresAt: "2026-01-04T00:00:00.000Z",
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

  // This page rendered its own two-entry copy of the strip, so the Roles tab
  // was unreachable from here the moment Roles was added (#3110). It takes the
  // shared component now: one place decides which tabs exist, and the next tab
  // appears on every Organization page at once.
  it("carry Roles, the same strip every other Organization page shows", async () => {
    await renderApiKeys(readOk([live]));
    const tabs = screen.getByRole("navigation", { name: "Organization" });
    const roles = within(tabs).getByRole("link", { name: "Roles" });
    expect(roles).toHaveAttribute("href", "/acme/roles");
    expect(roles).not.toHaveAttribute("aria-current");
    expect(within(tabs).getAllByRole("link")).toHaveLength(3);
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
    expect(rowFor(unused)).toHaveTextContent("Mar 1, 2027");
  });

  it("says a key was never used and never expires rather than inventing a date", async () => {
    await renderApiKeys(readOk([live, unused]));
    expect(rowFor(unused)).toHaveTextContent("Never used");
    expect(rowFor(live)).toHaveTextContent("Never");
    expect(rowFor(live)).not.toHaveTextContent("Never used");
  });

  it("marks a key live, expired or revoked off the instants it records, as a dot and a word", async () => {
    await renderApiKeys(
      readOk([live, unused, expired, revoked, revokedAndExpired]),
    );
    const statusOf = (key: ApiKey) =>
      rowFor(key).querySelector("[data-status]")?.getAttribute("data-status") ??
      null;

    expect(statusOf(live)).toBe("live");
    // An expiry still ahead of us is live.
    expect(statusOf(unused)).toBe("live");
    expect(statusOf(expired)).toBe("expired");
    expect(statusOf(revoked)).toBe("revoked");
    expect(statusOf(revokedAndExpired)).toBe("revoked");

    expect(within(rowFor(live)).getByText("live")).toBeInTheDocument();
    expect(within(rowFor(expired)).getByText("expired")).toBeInTheDocument();
    expect(within(rowFor(revoked)).getByText("revoked")).toBeInTheDocument();
  });

  it("does not print the word live beside an Expires date already behind us (negative)", async () => {
    await renderApiKeys(readOk([expired]));
    expect(within(rowFor(expired)).queryByText("live")).toBeNull();
    // The Expires column still prints the recorded instant beside it.
    expect(rowFor(expired)).toHaveTextContent("2026");
  });

  it("says what a key can do, and renders no secret and no lifecycle control (negative)", async () => {
    await renderApiKeys(readOk([live, revoked]));
    expect(
      screen.getByText(
        "A key acts as the person who created it: on the API, MCP and the CLI it can do what that person can do, and no more.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/secret|hash/i)).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
  });
});

describe("empty", () => {
  it("says the organization holds no keys, in place of the table", async () => {
    await renderApiKeys(readOk([]));
    expect(
      screen.getByText("This organization has no API keys."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
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
