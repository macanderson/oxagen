// @vitest-environment jsdom
// The Connections tab as a person reads and acts on it: the workspace's
// connections above the credential grants log, a detail drawer over one of
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

const { Connections } = await import("./connections");
const { connectionList, credentialGrantPage } = await import(
  "./tools.builders"
);
const { connectionGetOutput } = await import("@/test/tools-outputs");
const { ConnectionDetail } = await import("@/data/contracts/tools");

const at = { org: "acme", ws: "core-platform" };
const CONNECTIONS = "/acme/core-platform/tools?tab=connections";

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
  return withIntl(
    <Connections
      at={at}
      orgRole={orgRole}
      cursor={null}
      connections={connections ?? readOk(connectionList())}
      read={grants ?? readOk(credentialGrantPage())}
    />,
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
    // Owner, Reviewed and Next review: three cells, three not-recorded marks.
    expect(github.querySelectorAll("[data-not-carried]")).toHaveLength(3);
    expect(
      screen.getByText(
        "Owner, Reviewed and Next review have no field on the connection record, so they are shown as not recorded rather than guessed.",
      ),
    ).toBeVisible();
  });

  it("says a connection that never synced did not, rather than dating it", () => {
    renderTab();
    const table = screen.getByRole("table", { name: "Connections" });
    const stripe = rowOf(within(table).getByText("Acme Stripe"));
    // Owner, Reviewed, Next review and the missing last sync.
    expect(stripe.querySelectorAll("[data-not-carried]")).toHaveLength(4);
  });

  it("says nothing is stored when the workspace has no connection", () => {
    renderTab({ connections: readOk(connectionList({ connections: [] })) });
    expect(screen.getByText("No connection is stored")).toBeVisible();
    // The log below is a separate read and is still drawn.
    expect(
      screen.getByRole("table", { name: "Credential grants" }),
    ).toBeInTheDocument();
  });

  it("shows the denied state for the connections read and keeps the log", () => {
    renderTab({
      connections: { ok: false, reason: "denied", permission: "tools.read" },
    });
    expect(screen.getByTestId("tools-denied")).toBeVisible();
    expect(
      screen.getByRole("table", { name: "Credential grants" }),
    ).toBeInTheDocument();
  });

  it("shows the error state with the code the read reported", () => {
    renderTab({ connections: readError("tools_unavailable", 502) });
    expect(screen.getByTestId("tools-error")).toHaveTextContent(
      "tools_unavailable",
    );
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
