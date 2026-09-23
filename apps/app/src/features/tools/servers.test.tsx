// @vitest-environment jsdom
// The servers section under the registry, and the register dialog: the roster
// `list_mcp_servers` answers, the health word each row recorded, and what
// `register_mcp_server` reported about the endpoint it just probed.
//
// What these tests pin is the same discipline the rest of the Tools page
// keeps. A plugin-installed server carries transport `sse` and health
// `unknown`, and the page prints "Not checked" rather than a friendlier word
// or a guess. The register form offers only the two transports the contract
// accepts. The auth config is typed once and never rendered back. Each state
// ends in an axe check (INV-26).
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
import type { McpServerList } from "@/data/contracts/tools";
import { type Read, readError, readOk } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, registerServer } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  registerServer: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ registerServer }));

const { Servers } = await import("./servers");
const { mcpServerList } = await import("./tools.builders");

const at = { org: "acme", ws: "core-platform" };
const TOOLS = "/acme/core-platform/tools";

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

function renderServers({
  read,
  canRegister = true,
  orgRole = "owner",
}: {
  read?: Read<McpServerList>;
  canRegister?: boolean;
  orgRole?: OrgRole;
} = {}) {
  return withIntl(
    <Servers
      at={at}
      orgRole={orgRole}
      canRegister={canRegister}
      read={read ?? readOk(mcpServerList())}
    />,
  );
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  for (const fn of [router.replace, registerServer]) fn.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Servers", () => {
  it("prints each server with its transport, endpoint, health and pin count", () => {
    renderServers();
    const table = screen.getByRole("table", { name: "Providers" });
    const stripe = rowOf(within(table).getByText("Stripe"));
    expect(within(stripe).getByText("mcs_01k5s1")).toBeInTheDocument();
    expect(within(stripe).getByText("Streamable HTTP")).toBeInTheDocument();
    expect(within(stripe).getByText("Healthy")).toBeInTheDocument();
    expect(within(stripe).getByText("12")).toBeInTheDocument();
  });

  it("prints the unknown health a plugin-installed row carries, and says why", () => {
    renderServers();
    const table = screen.getByRole("table", { name: "Providers" });
    const github = rowOf(within(table).getByText("GitHub"));
    expect(within(github).getByText("Not checked")).toBeInTheDocument();
    expect(within(github).getByText("SSE")).toBeInTheDocument();
    // Never health checked: the date cell says not recorded, not a date.
    expect(github.querySelectorAll("[data-not-carried]")).toHaveLength(1);
    expect(
      screen.getByText(
        "A server installed by a plugin is written with the SSE transport and no health check, so its health reads as not checked until one runs.",
      ),
    ).toBeVisible();
  });

  it("says nothing is registered when the roster is empty", () => {
    renderServers({ read: readOk(mcpServerList({ servers: [] })) });
    expect(screen.getByText("No provider is registered")).toBeVisible();
    expect(screen.getByTestId("server-register-open")).toBeVisible();
  });

  it("shows the denied state when the roster read was refused", () => {
    renderServers({
      read: { ok: false, reason: "denied", permission: "tools.read" },
      orgRole: "member",
    });
    expect(screen.getByTestId("tools-denied")).toBeVisible();
  });

  it("shows the error state with the code the read reported", () => {
    renderServers({ read: readError("tools_unavailable", 502) });
    expect(screen.getByTestId("tools-error")).toHaveTextContent(
      "tools_unavailable",
    );
  });

  it("offers no register control to a reader who may not register", () => {
    renderServers({ canRegister: false, orgRole: "member" });
    expect(
      screen.queryByTestId("server-register-open"),
    ).not.toBeInTheDocument();
  });
});

describe("RegisterServer", () => {
  it("offers only the HTTP transport the runtime supports", () => {
    renderServers();
    fireEvent.click(screen.getByTestId("server-register-open"));
    const options = within(screen.getByLabelText("Transport")).getAllByRole(
      "option",
    );
    expect(options.map((option) => option.textContent)).toEqual([
      "streamable-http",
    ]);
  });

  it("registers a server and reports the health and pins the probe found", async () => {
    registerServer.mockResolvedValue({
      ok: true,
      value: {
        serverId: "mcs_01k5s9",
        healthStatus: "healthy",
        discoveredTools: ["get_page", "create_page"],
      },
    });
    renderServers();
    fireEvent.click(screen.getByTestId("server-register-open"));
    fill("Name", "Notion");
    fill("Endpoint URL", "https://mcp.notion.example/v1");
    fireEvent.change(screen.getByLabelText("Auth"), {
      target: { value: "bearer" },
    });
    fill("Auth config", "token = secret-value");
    fireEvent.submit(formOf(screen.getByText("Register provider")));
    await waitFor(() => {
      expect(registerServer).toHaveBeenCalledWith("acme", "core-platform", {
        name: "Notion",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.notion.example/v1",
        authStrategy: "bearer",
        authConfig: { token: "secret-value" },
      });
    });
    const done = await screen.findByTestId("server-register-done");
    expect(done).toHaveTextContent("mcs_01k5s9");
    expect(done).toHaveTextContent("2 pinned tools");
    expect(router.replace).toHaveBeenCalledWith(TOOLS);
  });

  it("leaves no field holding the auth config once the register answered", async () => {
    registerServer.mockResolvedValue({
      ok: true,
      value: {
        serverId: "mcs_01k5s9",
        healthStatus: "healthy",
        discoveredTools: [],
      },
    });
    renderServers();
    fireEvent.click(screen.getByTestId("server-register-open"));
    fill("Name", "Notion");
    fill("Endpoint URL", "https://mcp.notion.example/v1");
    fireEvent.change(screen.getByLabelText("Auth"), {
      target: { value: "bearer" },
    });
    fill("Auth config", "token = secret-value");
    fireEvent.submit(formOf(screen.getByText("Register provider")));
    await screen.findByTestId("server-register-done");
    for (const field of document.querySelectorAll("input, textarea")) {
      if (field instanceof HTMLInputElement) {
        expect(field.value).not.toContain("secret-value");
      }
    }
    expect(document.body.textContent).not.toContain("secret-value");
  });

  it("refuses an auth config line with no value rather than dropping it", async () => {
    renderServers();
    fireEvent.click(screen.getByTestId("server-register-open"));
    fill("Name", "Notion");
    fill("Endpoint URL", "https://mcp.notion.example/v1");
    fireEvent.change(screen.getByLabelText("Auth"), {
      target: { value: "bearer" },
    });
    fill("Auth config", "token");
    fireEvent.submit(formOf(screen.getByText("Register provider")));
    expect(
      await screen.findByTestId("server-register-failure"),
    ).toBeInTheDocument();
    expect(registerServer).not.toHaveBeenCalled();
  });

  it("names the refusal where the person acted and navigates nowhere", async () => {
    registerServer.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderServers();
    fireEvent.click(screen.getByTestId("server-register-open"));
    fill("Name", "Notion");
    fill("Endpoint URL", "https://mcp.notion.example/v1");
    fireEvent.submit(formOf(screen.getByText("Register provider")));
    expect(
      await screen.findByTestId("server-register-failure"),
    ).toHaveTextContent("This needs an organization Owner or Admin.");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a write that threw before it answered", async () => {
    registerServer.mockRejectedValue(new Error("network"));
    renderServers();
    fireEvent.click(screen.getByTestId("server-register-open"));
    fill("Name", "Notion");
    fill("Endpoint URL", "https://mcp.notion.example/v1");
    fireEvent.submit(formOf(screen.getByText("Register provider")));
    expect(
      await screen.findByTestId("server-register-failure"),
    ).toHaveTextContent("action_failed");
  });
});
