// @vitest-environment jsdom
/**
 * mcp-server-list.test.tsx — unit tests for connectionDisplay + McpServerList.
 *
 * connectionDisplay is the pure status → display mapping that drives the
 * Status column; McpServerList renders it plus the Authenticate /
 * Re-authenticate action linking into GET /api/v1/mcp/oauth/authorize.
 *
 * Covers:
 *   (a) connectionDisplay for every branch:
 *       oauth × {null, active, needs_reauth, revoked}, secret × {null, active},
 *       and authKind "none"
 *   (b) an oauth row without a credential renders the "Needs authentication"
 *       badge and an Authenticate link into the authorize route carrying the
 *       orgListingId + a same-org returnTo
 *   (c) an oauth row with an active credential renders Connected +
 *       Re-authenticate
 *   (d) a secret row renders no authenticate action
 *   (e) the empty state renders when no servers are installed
 *
 * Renders the real @/components/ui/* components in jsdom (same convention as
 * marketplace-modal.test.tsx) so the coss-ui Button `render={<a/>}` swap is
 * exercised for real.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  McpServerList,
  connectionDisplay,
  type McpServerRow,
} from "./mcp-server-list";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (a) connectionDisplay — pure branch coverage
// ---------------------------------------------------------------------------

describe("connectionDisplay", () => {
  it("oauth + no credential → Needs authentication / warning / Authenticate", () => {
    expect(connectionDisplay("oauth", null)).toEqual({
      label: "Needs authentication",
      variant: "warning",
      action: "Authenticate",
    });
  });

  it("oauth + active → Connected / success / Re-authenticate", () => {
    expect(connectionDisplay("oauth", "active")).toEqual({
      label: "Connected",
      variant: "success",
      action: "Re-authenticate",
    });
  });

  it("oauth + needs_reauth → Needs re-auth / error / Re-authenticate", () => {
    expect(connectionDisplay("oauth", "needs_reauth")).toEqual({
      label: "Needs re-auth",
      variant: "error",
      action: "Re-authenticate",
    });
  });

  it("oauth + revoked → Revoked / error / Authenticate", () => {
    expect(connectionDisplay("oauth", "revoked")).toEqual({
      label: "Revoked",
      variant: "error",
      action: "Authenticate",
    });
  });

  it("secret + no credential → Secret required / warning / Enter API key", () => {
    expect(connectionDisplay("secret", null)).toEqual({
      label: "Secret required",
      variant: "warning",
      action: "Enter API key",
    });
  });

  it("secret + active → Connected / success / Update API key", () => {
    expect(connectionDisplay("secret", "active")).toEqual({
      label: "Connected",
      variant: "success",
      action: "Update API key",
    });
  });

  it("none → No auth needed / muted / no action", () => {
    expect(connectionDisplay("none", null)).toEqual({
      label: "No auth needed",
      variant: "muted",
      action: null,
    });
  });
});

// ---------------------------------------------------------------------------
// McpServerList — render tests
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "srv-1",
    name: "stripe",
    title: "Stripe",
    description: "Payments MCP server",
    endpointUrl: "https://mcp.stripe.com",
    transport: "streamable-http",
    authKind: "oauth",
    enabled: true,
    credentialStatus: null,
    ...overrides,
  };
}

function renderList(
  rows: McpServerRow[],
  revokeAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
  }) => Promise<{ ok: boolean; revoked?: boolean; error?: string }> = vi.fn(
    async () => ({ ok: true, revoked: true }),
  ),
  reauthListingId?: string | null,
  saveSecretAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
    secret: string;
  }) => Promise<{ ok: boolean; error?: string }> = vi.fn(async () => ({
    ok: true,
  })),
) {
  return render(
    <McpServerList
      orgSlug="acme"
      workspaceSlug="main"
      initialServers={rows}
      toggleAction={vi.fn(async () => ({ ok: true }))}
      uninstallAction={vi.fn(async () => ({ ok: true }))}
      revokeAction={revokeAction}
      saveSecretAction={saveSecretAction}
      reauthListingId={reauthListingId}
    />,
  );
}

describe("McpServerList", () => {
  // (b) oauth row without a credential — the core authenticate UX
  it("renders the Needs authentication badge and an Authenticate link for an unauthenticated oauth row", () => {
    renderList([makeRow()]);

    expect(screen.getByTestId("mcp-server-status-srv-1")).toHaveTextContent(
      "Needs authentication",
    );

    const link = screen.getByTestId("mcp-server-authenticate-srv-1");
    expect(link).toHaveTextContent("Authenticate");

    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("/api/v1/mcp/oauth/authorize?");
    expect(href).toContain("orgListingId=srv-1");

    // The link round-trips the user back to this page after the flow.
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("orgSlug")).toBe("acme");
    expect(params.get("workspaceSlug")).toBe("main");
    expect(params.get("returnTo")).toBe("/acme/main/workbench/tools/mcp");
  });

  // (c) oauth row with an active credential
  it("renders Connected + a Re-authenticate link for an oauth row with an active credential", () => {
    renderList([makeRow({ credentialStatus: "active" })]);

    expect(screen.getByTestId("mcp-server-status-srv-1")).toHaveTextContent(
      "Connected",
    );
    expect(
      screen.getByTestId("mcp-server-authenticate-srv-1"),
    ).toHaveTextContent("Re-authenticate");
  });

  // (d) secret rows get a secret-entry action, never the OAuth authorize link
  it("renders no OAuth authorize link for a secret row (uses the secret dialog trigger instead)", () => {
    renderList([
      makeRow({ id: "srv-2", authKind: "secret", credentialStatus: "active" }),
    ]);

    expect(screen.getByTestId("mcp-server-status-srv-2")).toHaveTextContent(
      "Connected",
    );
    // No navigation link into the OAuth authorize route…
    expect(
      screen.queryByTestId("mcp-server-authenticate-srv-2"),
    ).not.toBeInTheDocument();
    // …but an "Update API key" dialog trigger is present.
    expect(screen.getByTestId("mcp-server-set-secret-srv-2")).toHaveTextContent(
      "Update API key",
    );
  });

  // (d2) secret-auth server without a key: Enter API key → dialog → save flow
  it("opens the secret dialog, saves the key, and flips the row to Connected", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => ({ ok: true }));
    renderList(
      [makeRow({ id: "srv-3", authKind: "secret", credentialStatus: null })],
      undefined,
      undefined,
      save,
    );

    expect(screen.getByTestId("mcp-server-status-srv-3")).toHaveTextContent(
      "Secret required",
    );
    await user.click(screen.getByTestId("mcp-server-set-secret-srv-3"));

    // The dialog opens; type an API key and save.
    const input = await screen.findByTestId("mcp-secret-input");
    await user.type(input, "sk_live_abc123");
    await user.click(screen.getByTestId("mcp-secret-save"));

    expect(save).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "srv-3",
      secret: "sk_live_abc123",
    });
    // Optimistic: the row flips to Connected without a reload.
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("renders the server title and endpoint for each row", () => {
    renderList([makeRow()]);
    expect(screen.getByTestId("mcp-server-name-srv-1")).toHaveTextContent(
      "Stripe",
    );
    expect(screen.getByText("https://mcp.stripe.com")).toBeInTheDocument();
  });

  // (e) empty state
  it("renders the empty state when no servers are installed", () => {
    renderList([]);
    expect(
      screen.getByText(/No MCP servers installed yet/i),
    ).toBeInTheDocument();
  });

  // (f) remove-auth action — only rows with a stored credential offer it
  it("renders Remove auth for a row with a credential and clears the status after revoking", async () => {
    const user = userEvent.setup();
    const revoke = vi.fn(async () => ({ ok: true, revoked: true }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderList([makeRow({ credentialStatus: "active" })], revoke);

    const btn = screen.getByTestId("mcp-server-revoke-srv-1");
    expect(btn).toHaveTextContent("Remove auth");
    await user.click(btn);

    expect(revoke).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "srv-1",
    });
    // Credential gone → status falls back to Needs authentication, action gone.
    expect(await screen.findByText("Needs authentication")).toBeInTheDocument();
    expect(
      screen.queryByTestId("mcp-server-revoke-srv-1"),
    ).not.toBeInTheDocument();
  });

  it("offers no Remove auth action when no credential is stored", () => {
    renderList([makeRow()]);
    expect(
      screen.queryByTestId("mcp-server-revoke-srv-1"),
    ).not.toBeInTheDocument();
  });

  // (g) ?reauth deep-link landing — highlight + scroll the target row
  it("highlights and scrolls the row named by reauthListingId", () => {
    const scrollSpy = vi.fn();
    // jsdom has no scrollIntoView — stub it so the effect can call it.
    Element.prototype.scrollIntoView = scrollSpy;
    renderList(
      [
        makeRow({ id: "srv-1" }),
        makeRow({ id: "srv-2", name: "linear", title: "Linear" }),
      ],
      undefined,
      "srv-2",
    );

    const row = screen.getByTestId("mcp-server-row-srv-2");
    // The reauth target carries the highlight ring…
    expect(row.className).toContain("ring-warning/40");
    // …and non-target rows do not.
    expect(screen.getByTestId("mcp-server-row-srv-1").className).not.toContain(
      "ring-warning/40",
    );
    // …and the target was scrolled into view.
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("does not highlight anything when reauthListingId matches no installed row", () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderList([makeRow({ id: "srv-1" })], undefined, "srv-gone");
    expect(screen.getByTestId("mcp-server-row-srv-1").className).not.toContain(
      "ring-warning/40",
    );
  });
});
