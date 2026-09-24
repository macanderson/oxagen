// @vitest-environment jsdom
// The connections and the credential grants log on the Providers tab, as a
// person reads and acts on them: the workspace's connections above the log, a detail drawer over one of
// them, and the add-connection dialog.
//
// Three things these tests pin, because the tab is about what was recorded:
//
//   - the three review columns the mockup draws and the record has no field
//     for render the not-recorded state, never a name or a date;
//   - the add dialog reports `pending_setup` as the status the create
//     answered, and never calls a new connection live;
//   - the credential is sent once and never comes back: after a successful
//     add, no input in the document holds what was typed.
//
// Each state ends in an axe check (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Read } from "@/data/read";
import { readError, readOk } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, addConnection, readConnection } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  addConnection: vi.fn(),
  readConnection: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ addConnection, readConnection }));

const { ConnectionsTable, GrantsLog } = await import("./connections");
const { connectionList, credentialGrantPage } = await import(
  "./tools.builders"
);
const { connectionGetOutput, credentialGrantListOutput } = await import(
  "@/test/tools-outputs"
);
const { ConnectionDetail } = await import("@/data/contracts/tools");

const at = { org: "acme", ws: "core-platform" };
const CONNECTIONS = "/acme/core-platform/tools/providers";

/** The element or a failure naming what was missing: the tests assert, they never cast. */
function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}
const rowOf = (node: HTMLElement) => element(node.closest("tr"), "row");
const formOf = (node: HTMLElement) => element(node.closest("form"), "form");

function withIntl(node: ReactNode) {
  return render(<IntlProvider>{node}</IntlProvider>);
}

type Reads = {
  connections?: Read<ReturnType<typeof connectionList>>;
  grants?: Read<ReturnType<typeof credentialGrantPage>>;
  orgRole?: OrgRole;
};

function renderTab({ connections, grants, orgRole = "owner" }: Reads = {}) {
  // The two panels as the Providers tab stacks them, below the roster.
  return withIntl(
    <>
      <ConnectionsTable
        at={at}
        orgRole={orgRole}
        read={connections ?? readOk(connectionList())}
      />
      <GrantsLog
        at={at}
        orgRole={orgRole}
        cursor={null}
        read={grants ?? readOk(credentialGrantPage())}
      />
    </>,
  );
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/**
 * One connection as the drawer is handed it: the contract's record with its
 * database uuid dropped and its public id carried as `id` (INV-11), which is
 * what `readConnection` does.
 */
function detail() {
  const { id: _rowId, publicId, connectorId, ...rest } = connectionGetOutput();
  return ConnectionDetail.parse({
    id: publicId,
    connector: connectorId,
    ...rest,
  });
}

beforeEach(() => {
  for (const fn of [router.replace, addConnection, readConnection]) {
    fn.mockReset();
  }
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Connections table", () => {
  it("prints each connection with the status and health the record holds", () => {
    renderTab();
    const table = screen.getByRole("table", { name: "Connections" });
    const github = rowOf(within(table).getByText("Acme GitHub"));
    expect(within(github).getByText("github")).toBeInTheDocument();
    expect(within(github).getByText("bearer_token")).toBeInTheDocument();
    expect(within(github).getByText("Healthy")).toBeInTheDocument();
    expect(within(github).getByText("Connected")).toBeInTheDocument();

    // The create answers pending_setup; the table prints that word rather
    // than a friendlier one, and degraded health is not softened either.
    const stripe = rowOf(within(table).getByText("Acme Stripe"));
    expect(within(stripe).getByText("Pending setup")).toBeInTheDocument();
    expect(within(stripe).getByText("Degraded")).toBeInTheDocument();
  });

  it("renders the not-recorded state for the three columns no contract carries", () => {
    renderTab();
    const table = screen.getByRole("table", { name: "Connections" });
    const github = rowOf(within(table).getByText("Acme GitHub"));
    // Owner, Reviewed and Next review: three cells, three not-backed marks,
    // each carrying the issue that owns the connection's review record.
    const marks = github.querySelectorAll('[data-state="not-backed"]');
    expect(marks).toHaveLength(3);
    for (const mark of marks) {
      expect(mark.getAttribute("data-gap")).toMatch(/^#\d+$/);
    }
    expect(
      screen.getByText(
        "Owner, Reviewed and Next review have no field on the connection record yet.",
      ),
    ).toBeVisible();
  });

  it("says a connection that never synced did not, rather than dating it", () => {
    renderTab();
    const table = screen.getByRole("table", { name: "Connections" });
    const stripe = rowOf(within(table).getByText("Acme Stripe"));
    // Owner, Reviewed and Next review are not backed; the missing last sync
    // is a value the record carries as absent.
    expect(stripe.querySelectorAll('[data-state="not-backed"]')).toHaveLength(
      3,
    );
    expect(stripe.querySelectorAll("[data-not-carried]")).toHaveLength(1);
  });

  it("says nothing is stored when the workspace has no connection", () => {
    renderTab({ connections: readOk(connectionList({ connections: [] })) });
    expect(screen.getByText("No connection is stored")).toBeVisible();
    // The log below is a separate read and is still drawn.
    expect(
      screen.getByRole("table", { name: "Credential grants log" }),
    ).toBeInTheDocument();
  });

  it("shows the denied state for the connections read and keeps the log", () => {
    renderTab({
      connections: { ok: false, reason: "denied", permission: "tools.read" },
    });
    expect(screen.getByTestId("tools-denied")).toBeVisible();
    expect(
      screen.getByRole("table", { name: "Credential grants log" }),
    ).toBeInTheDocument();
  });

  it("shows the error state with the code the read reported", () => {
    renderTab({ connections: readError("tools_unavailable", 502) });
    expect(screen.getByTestId("tools-error")).toHaveTextContent(
      "tools_unavailable",
    );
  });
});

describe("Credential grants log", () => {
  it("shows the denied state for the log's read and keeps the connections", () => {
    renderTab({
      grants: { ok: false, reason: "denied", permission: "tools.read" },
    });
    expect(screen.getByTestId("tools-denied")).toHaveTextContent("tools.read");
    expect(
      screen.queryByRole("table", { name: "Credential grants log" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: "Connections" }),
    ).toBeInTheDocument();
  });

  it("names the log's outage with its code, and offers Try again on the Providers tab", () => {
    renderTab({ grants: readError("tools_unavailable", 502) });
    const error = screen.getByTestId("tools-error");
    expect(error).toHaveTextContent("tools_unavailable");
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", CONNECTIONS);
  });

  it("says no credential has been put to use when the log is empty from its start", () => {
    renderTab({ grants: readOk(credentialGrantPage({ items: [] })) });
    const empty = screen
      .getByRole("heading", { name: "No credential has been put to use" })
      .closest("section");
    expect(empty).toHaveAttribute("data-state", "empty");
    expect(
      screen.queryByRole("table", { name: "Credential grants log" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the log's frame on a later page that came back empty, rather than calling the log empty", () => {
    withIntl(
      <GrantsLog
        at={at}
        orgRole="owner"
        cursor="cur_2"
        read={readOk(credentialGrantPage({ items: [] }))}
      />,
    );
    expect(
      screen.getByRole("table", { name: "Credential grants log" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No credential has been put to use"),
    ).not.toBeInTheDocument();
  });

  it("links the next page of the log on the Providers tab", () => {
    renderTab({
      grants: readOk(credentialGrantPage({ nextCursor: "cur_2" })),
    });
    expect(screen.getByTestId("tools-next-page")).toHaveAttribute(
      "href",
      `${CONNECTIONS}?cursor=cur_2`,
    );
  });

  it("prints a grant's TTL in minutes, and a dash for a window that ends before it starts", () => {
    const [first, second] = credentialGrantListOutput().items;
    if (first === undefined || second === undefined) {
      throw new Error("fixture lost a grant");
    }
    renderTab({
      grants: readOk(
        credentialGrantPage({
          items: [
            first,
            {
              ...second,
              issuedAt: "2026-09-11T08:50:19.000Z",
              expiresAt: "2026-09-11T08:40:19.000Z",
            },
          ],
        }),
      ),
    });
    const log = screen.getByRole("table", { name: "Credential grants log" });
    const ttl = (id: string) =>
      within(rowOf(within(log).getByText(id))).getAllByRole("cell")[5];
    expect(ttl("mcgr_01k5g1")).toHaveTextContent(/^5m$/);
    expect(ttl("mcgr_01k5g2")).toHaveTextContent(/^—$/);
  });
});

describe("Connection drawer", () => {
  it("reads the connection on open and prints what get_connection carries", async () => {
    readConnection.mockResolvedValue({ ok: true, value: detail() });
    renderTab();
    fireEvent.click(screen.getByTestId("connection-open-con_01k5n1"));
    expect(readConnection).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "con_01k5n1",
    );
    const drawer = within(await screen.findByTestId("connection-drawer"));
    expect(drawer.getByText("webhook")).toBeInTheDocument();
    expect(drawer.getByText("Connected")).toBeInTheDocument();
    expect(drawer.getByText("482")).toBeInTheDocument();
    // The drawer says the credential is never read back, because a detail
    // view is exactly where a reader would look for it.
    expect(
      drawer.getByText(
        "The stored credential is never read back to this page. The broker mints a narrowed credential per call and records the grant below.",
      ),
    ).toBeVisible();
  });

  it("names a refused detail read in a read's words, not a write's", async () => {
    // The seam answers a denied read with the page's own permission, so the
    // drawer says the read was refused rather than "nothing was changed".
    readConnection.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "tools.read",
    });
    renderTab();
    fireEvent.click(screen.getByTestId("connection-open-con_01k5n1"));
    expect(
      await screen.findByTestId("connection-drawer-failure"),
    ).toHaveTextContent(
      "Reading this connection needs a role this workspace has not given you.",
    );
  });

  it("names a read that threw before it answered", async () => {
    readConnection.mockRejectedValue(new Error("network"));
    renderTab();
    fireEvent.click(screen.getByTestId("connection-open-con_01k5n1"));
    expect(
      await screen.findByTestId("connection-drawer-failure"),
    ).toHaveTextContent("action_failed");
  });

  it("names the store failure with the code the read reported", async () => {
    readConnection.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "tools_unavailable",
    });
    renderTab();
    fireEvent.click(screen.getByTestId("connection-open-con_01k5n1"));
    expect(
      await screen.findByTestId("connection-drawer-failure"),
    ).toHaveTextContent("tools_unavailable");
  });
});

describe("Add connection", () => {
  it("sends the credential once and reports the pending_setup the create answered", async () => {
    addConnection.mockResolvedValue({
      ok: true,
      value: {
        id: "con_01k5n9",
        status: "pending_setup",
        connectorId: "linear",
        displayName: "Acme Linear",
      },
    });
    renderTab();
    fireEvent.click(screen.getByTestId("connection-add-open"));
    fill("Connector", "linear");
    fill("Name", "Acme Linear");
    fireEvent.change(screen.getByLabelText("Credential"), {
      target: { value: "bearer_token" },
    });
    fill("Bearer token", "tok-live-secret");
    fireEvent.submit(formOf(screen.getByText("Add connection")));
    await waitFor(() => {
      expect(addConnection).toHaveBeenCalledWith("acme", "core-platform", {
        connectorId: "linear",
        displayName: "Acme Linear",
        scheme: "bearer_token",
        secrets: { token: "tok-live-secret" },
        deliveryMethod: "",
      });
    });
    const done = await screen.findByTestId("connection-add-done");
    expect(done).toHaveTextContent("con_01k5n9");
    expect(done).toHaveTextContent("pending setup");
    expect(router.replace).toHaveBeenCalledWith(CONNECTIONS);
  });

  it("leaves no field holding the credential once the create answered", async () => {
    addConnection.mockResolvedValue({
      ok: true,
      value: {
        id: "con_01k5n9",
        status: "pending_setup",
        connectorId: "linear",
        displayName: "Acme Linear",
      },
    });
    renderTab();
    fireEvent.click(screen.getByTestId("connection-add-open"));
    fill("Connector", "linear");
    fill("Name", "Acme Linear");
    fireEvent.change(screen.getByLabelText("Credential"), {
      target: { value: "bearer_token" },
    });
    fill("Bearer token", "tok-live-secret");
    fireEvent.submit(formOf(screen.getByText("Add connection")));
    await screen.findByTestId("connection-add-done");
    // Not in an input, and not anywhere else in the document: the form is
    // replaced by the outcome and the outcome names the connection only.
    for (const field of document.querySelectorAll("input, textarea")) {
      if (field instanceof HTMLInputElement) {
        expect(field.value).not.toContain("tok-live-secret");
      }
    }
    expect(document.body.textContent).not.toContain("tok-live-secret");
  });

  it("offers the control to a member and lets the server refuse them", async () => {
    addConnection.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderTab({ orgRole: "member" });
    // The control is not hidden: create_connection asserts the role itself,
    // and a reader is told which role it wants where they acted.
    fireEvent.click(screen.getByTestId("connection-add-open"));
    fill("Connector", "linear");
    fill("Name", "Acme Linear");
    fill("API key", "key-secret");
    fireEvent.submit(formOf(screen.getByText("Add connection")));
    expect(
      await screen.findByTestId("connection-add-failure"),
    ).toHaveTextContent("This needs an organization Owner or Admin.");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("suggests the connectors already in use, and none when the workspace has none", () => {
    renderTab();
    fireEvent.click(screen.getByTestId("connection-add-open"));
    const suggestions = element(
      document.querySelector("#connection-add-slugs"),
      "connector suggestions",
    );
    expect(
      [...suggestions.querySelectorAll("option")].map((o) => o.value),
    ).toEqual(["github", "stripe"]);
    expect(screen.getByLabelText("Connector")).toHaveAttribute(
      "list",
      "connection-add-slugs",
    );
    cleanup();

    renderTab({ connections: readOk(connectionList({ connections: [] })) });
    fireEvent.click(screen.getByTestId("connection-add-open"));
    expect(document.querySelector("#connection-add-slugs")).toBeNull();
    expect(screen.getByLabelText("Connector")).not.toHaveAttribute("list");
  });

  it("clears a refusal when the dialog is closed, so reopening starts clean", async () => {
    addConnection.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderTab();
    fireEvent.click(screen.getByTestId("connection-add-open"));
    fill("Connector", "linear");
    fill("Name", "Acme Linear");
    fill("API key", "key-secret");
    fireEvent.submit(formOf(screen.getByText("Add connection")));
    await screen.findByTestId("connection-add-failure");
    fireEvent.click(
      within(screen.getByTestId("connection-add-dialog")).getByRole("button", {
        name: "Close",
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId("connection-add-dialog"),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("connection-add-open"));
    await screen.findByTestId("connection-add-dialog");
    expect(
      screen.queryByTestId("connection-add-failure"),
    ).not.toBeInTheDocument();
  });

  it("offers the form again, empty, after a stored connection's dialog is closed", async () => {
    addConnection.mockResolvedValue({
      ok: true,
      value: {
        id: "con_01k5n9",
        status: "pending_setup",
        connectorId: "linear",
        displayName: "Acme Linear",
      },
    });
    renderTab();
    fireEvent.click(screen.getByTestId("connection-add-open"));
    fill("Connector", "linear");
    fill("Name", "Acme Linear");
    fill("API key", "key-secret");
    fireEvent.submit(formOf(screen.getByText("Add connection")));
    await screen.findByTestId("connection-add-done");
    fireEvent.click(
      within(screen.getByTestId("connection-add-dialog")).getByRole("button", {
        name: "Close",
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId("connection-add-dialog"),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("connection-add-open"));
    await screen.findByTestId("connection-add-dialog");
    expect(screen.queryByTestId("connection-add-done")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("sends one create while the first is still answering", async () => {
    let answer: (value: unknown) => void = () => undefined;
    addConnection.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderTab();
    fireEvent.click(screen.getByTestId("connection-add-open"));
    fill("Connector", "linear");
    fill("Name", "Acme Linear");
    fill("API key", "key-secret");
    const form = formOf(screen.getByText("Add connection"));
    fireEvent.submit(form);
    await screen.findByText("Adding…");
    fireEvent.submit(form);
    expect(addConnection).toHaveBeenCalledTimes(1);
    answer({
      ok: true,
      value: {
        id: "con_01k5n9",
        status: "pending_setup",
        connectorId: "linear",
        displayName: "Acme Linear",
      },
    });
    await screen.findByTestId("connection-add-done");
  });

  it("names a write that threw before it answered", async () => {
    addConnection.mockRejectedValue(new Error("network"));
    renderTab();
    fireEvent.click(screen.getByTestId("connection-add-open"));
    fill("Connector", "linear");
    fill("Name", "Acme Linear");
    fill("API key", "key-secret");
    fireEvent.submit(formOf(screen.getByText("Add connection")));
    expect(
      await screen.findByTestId("connection-add-failure"),
    ).toHaveTextContent("action_failed");
  });
});
