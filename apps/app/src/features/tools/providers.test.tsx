// @vitest-environment jsdom
// The Providers tab body on its own, with the reads it is handed: the roster
// that did not load, the roster with nothing in it, a registry whose count is
// a floor, and a reader who may not administer. Then the drill-down a row
// opens, in the states its record can be in (no versions, unreachable, a
// capability with no prefix), and the drill-down's two writes, Remove and
// Re-import, in every way each can answer: refused, thrown, and done. The page
// suite (tools.test.tsx) covers the happy path through the whole page; this
// suite covers what that one cannot reach without re-reading every tab. axe
// checks the state each test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/data/contracts/common";
import type { Read } from "@/data/read";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

const { router, actions } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  actions: {
    importTools: vi.fn(),
    removeProvider: vi.fn(),
    registerServer: vi.fn(),
    addConnection: vi.fn(),
    readConnection: vi.fn(),
    setToolClassification: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => actions);

const { Providers } = await import("./providers");
const { credentialGrantPage, connectionList, mcpServerList, toolVersionPage } =
  await import("./tools.builders");
const { mcpServerListOutput, toolVersionListOutput } = await import(
  "@/test/tools-outputs"
);

const at = { org: "acme", ws: "core-platform" };
const PROVIDERS = "/acme/core-platform/tools/providers";
const failure = translator("tools.actions.failure");
const drill = translator("tools.providers.drill");
const providers = translator("tools.providers");

type ServerRow = ReturnType<typeof mcpServerListOutput>["servers"][number];
type VersionRow = ReturnType<typeof toolVersionListOutput>["items"][number];

/** The fixture's nth record, or a failure naming which one was missing. */
function nth<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no ${what}`);
  return item;
}
const stripeServer = (): ServerRow =>
  nth(mcpServerListOutput().servers, 0, "Stripe server");
const stripeVersion = (): VersionRow =>
  nth(toolVersionListOutput().items, 0, "Stripe version");
const githubVersion = (): VersionRow =>
  nth(toolVersionListOutput().items, 1, "GitHub version");

type Props = {
  servers?: Read<ReturnType<typeof mcpServerList>>;
  versions?: Read<ReturnType<typeof toolVersionPage>>;
  canAdminister?: boolean;
  orgRole?: OrgRole;
};

function renderProviders({
  servers = readOk(mcpServerList()),
  versions = readOk(toolVersionPage()),
  canAdminister = true,
  orgRole = "owner",
}: Props = {}) {
  return render(
    <IntlProvider>
      <Providers
        at={at}
        orgRole={orgRole}
        canAdminister={canAdminister}
        servers={servers}
        versions={versions}
        connections={readOk(connectionList())}
        grants={readOk(credentialGrantPage())}
        cursor={null}
      />
    </IntlProvider>,
  );
}

/** One provider with the health and versions a test needs, the rest the fixture's. */
function oneProvider(
  server: Partial<ServerRow>,
  items: readonly VersionRow[],
  nextCursor: string | null = null,
) {
  return {
    servers: readOk(
      mcpServerList({ servers: [{ ...stripeServer(), ...server }] }),
    ),
    versions: readOk(toolVersionPage({ items: [...items], nextCursor })),
  };
}

async function openDrill(id = "mcs_01k5s1") {
  fireEvent.click(screen.getByTestId(`provider-open-${id}`));
  return within(await screen.findByTestId("provider-dialog"));
}

/** The value a drill-down fact prints, found by its term. */
function fact(dialog: ReturnType<typeof within>, term: string): HTMLElement {
  const dd = dialog.getByText(term).nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`no value for ${term}`);
  return dd;
}

beforeEach(() => {
  for (const fn of [...Object.values(actions), ...Object.values(router)]) {
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

describe("Providers › roster", () => {
  it("replaces only the roster when list_mcp_servers is refused, and keeps the connections and the log", () => {
    renderProviders({
      servers: { ok: false, reason: "denied", permission: "tools.read" },
      orgRole: "member",
    });
    expect(screen.getByTestId("tools-denied")).toBeVisible();
    expect(
      screen.queryByRole("table", { name: "Providers" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Credential grants log" }),
    ).toBeVisible();
    expect(screen.getByText("Acme GitHub")).toBeVisible();
  });

  it("draws an outage of the roster with its code, and no Add, which lives in the roster's own header", () => {
    renderProviders({ servers: readError("tool_registry_unavailable", 503) });
    expect(screen.getByTestId("tools-error")).toHaveTextContent(
      "tool_registry_unavailable",
    );
    // The page header keeps its own Import a provider; this body has no
    // roster header left to carry Add.
    expect(screen.queryByTestId("tools-import-open")).not.toBeInTheDocument();
  });

  it("says no provider is registered rather than drawing an empty table", () => {
    renderProviders({
      servers: readOk(mcpServerList({ servers: [] })),
      versions: readOk(toolVersionPage({ items: [] })),
    });
    const empty = screen.getByText(providers("empty"));
    expect(empty).toHaveAttribute("data-state", "empty");
    expect(
      screen.queryByRole("table", { name: "Providers" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("tools-providers-caption")).toHaveTextContent(
      "0 providers hold 0 tool versions.",
    );
    // An admin can still add the first one from the roster's own header.
    expect(screen.getByTestId("tools-import-open")).toHaveTextContent(
      "Add a provider",
    );
  });

  it("counts providers only, and marks each row's versions as a floor, while the registry has a later page", () => {
    renderProviders({
      versions: readOk(toolVersionPage({ nextCursor: "cur_2" })),
    });
    expect(screen.getByTestId("tools-providers-caption")).toHaveTextContent(
      providers("captionPartial", { providers: "2" }),
    );
    const stripe = screen.getByRole("button", { name: "Open Stripe" });
    const row = stripe.closest("tr");
    if (!(row instanceof HTMLElement)) throw new Error("no Stripe row");
    expect(within(row).getByText("1+")).toBeVisible();
  });

  it("counts providers only when the registry read failed, and shows each provider as holding at least none", () => {
    renderProviders({ versions: readError("tool_registry_unavailable", 503) });
    expect(screen.getByTestId("tools-providers-caption")).toHaveTextContent(
      providers("captionPartial", { providers: "2" }),
    );
    expect(screen.getAllByText("0+")).toHaveLength(2);
  });

  it("offers a reader who may not administer Open on each row, and no Add or Remove", () => {
    renderProviders({ canAdminister: false, orgRole: "member" });
    expect(screen.queryByTestId("tools-import-open")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("provider-remove-open-mcs_01k5s1"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("provider-open-mcs_01k5s1")).toBeVisible();
  });
});

describe("Providers › drill-down", () => {
  it("says what it cannot say about a provider the registry holds nothing from", async () => {
    renderProviders(oneProvider({}, []));
    const dialog = await openDrill();
    expect(
      within(fact(dialog, drill("facts.registryName"))).getByText(
        "not recorded",
      ),
    ).toBeVisible();
    expect(
      within(fact(dialog, drill("facts.schemas"))).getByText("not recorded"),
    ).toBeVisible();
    expect(fact(dialog, drill("facts.versions"))).toHaveTextContent("0");
    expect(dialog.getByText(drill("noTools"))).toBeVisible();
    expect(dialog.queryByRole("table")).not.toBeInTheDocument();
  });

  it("warns that an unreachable provider's tools cannot be called", async () => {
    renderProviders(oneProvider({ healthStatus: "unreachable" }, []));
    const dialog = await openDrill();
    expect(dialog.getByTestId("provider-health-warning")).toHaveTextContent(
      drill("healthWarning.unreachable"),
    );
  });

  it("prints no warning for a provider nobody has checked yet", async () => {
    renderProviders(oneProvider({ healthStatus: "unknown" }, []));
    const dialog = await openDrill();
    expect(
      dialog.queryByTestId("provider-health-warning"),
    ).not.toBeInTheDocument();
    expect(fact(dialog, drill("facts.lastCheck"))).toHaveTextContent(
      "not checked",
    );
  });

  it("reads the registry name off the capability's prefix, and the whole capability when it has none", async () => {
    renderProviders(
      oneProvider({}, [
        { ...stripeVersion(), capabilityId: "create_payment" },
        {
          ...githubVersion(),
          serverId: "mcs_01k5s1",
          capabilityId: "mcp.stripe.list_refunds",
        },
      ]),
    );
    const dialog = await openDrill();
    // The first version names the provider; this one has no dot to cut at.
    expect(fact(dialog, drill("facts.registryName"))).toHaveTextContent(
      "create_payment",
    );
    expect(fact(dialog, drill("facts.schemas"))).toHaveTextContent(
      drill("schemas", { declared: 1, imported: 1 }),
    );
  });

  it("counts a first page's versions as a floor and says a later page may hold more", async () => {
    renderProviders(oneProvider({}, [stripeVersion()], "cur_2"));
    const dialog = await openDrill();
    expect(fact(dialog, drill("facts.versions"))).toHaveTextContent("1+");
    expect(dialog.getByText(drill("partial"))).toBeVisible();
  });

  it("says a version's calls were not recorded rather than printing zero", async () => {
    renderProviders(
      oneProvider({}, [{ ...githubVersion(), serverId: "mcs_01k5s1" }]),
    );
    const dialog = await openDrill();
    const row = dialog.getByText("Get file contents").closest("tr");
    if (!(row instanceof HTMLElement)) throw new Error("no version row");
    const cells = within(row).getAllByRole("cell");
    expect(cells.at(-1)).toHaveTextContent("not recorded");
  });

  it("offers a reader who may not administer the facts and no write, not even authorization", async () => {
    renderProviders({ canAdminister: false, orgRole: "member" });
    const dialog = await openDrill();
    expect(dialog.getByText(drill("authNotBacked"))).toBeVisible();
    expect(
      dialog.queryByRole("button", { name: "Connect with OAuth" }),
    ).not.toBeInTheDocument();
    expect(
      dialog.queryByTestId("provider-reimport-mcs_01k5s1"),
    ).not.toBeInTheDocument();
    expect(
      dialog.queryByTestId("provider-remove-open-mcs_01k5s1"),
    ).not.toBeInTheDocument();
  });

  it("closes the drill-down when the provider it shows is removed from inside it", async () => {
    actions.removeProvider.mockResolvedValue({
      ok: true,
      value: { deleted: true },
    });
    renderProviders();
    const dialog = await openDrill();
    fireEvent.click(dialog.getByTestId("provider-remove-open-mcs_01k5s1"));
    fireEvent.click(await screen.findByTestId("provider-remove-confirm"));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(PROVIDERS);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("provider-dialog")).not.toBeInTheDocument();
    });
  });
});

describe("Providers › Remove", () => {
  it("names a removal that threw before it answered, and navigates nowhere", async () => {
    actions.removeProvider.mockRejectedValue(new Error("network"));
    renderProviders();
    fireEvent.click(screen.getByTestId("provider-remove-open-mcs_01k5s1"));
    fireEvent.click(await screen.findByTestId("provider-remove-confirm"));
    expect(
      await screen.findByTestId("provider-remove-failure"),
    ).toHaveTextContent(failure("unavailable", { code: "action_failed" }));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("clears a refusal when the dialog is closed, so reopening starts clean", async () => {
    actions.removeProvider.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "server_not_found",
    });
    renderProviders();
    fireEvent.click(screen.getByTestId("provider-remove-open-mcs_01k5s1"));
    fireEvent.click(await screen.findByTestId("provider-remove-confirm"));
    expect(
      await screen.findByTestId("provider-remove-failure"),
    ).toHaveTextContent(failure("serverNotFound"));
    fireEvent.click(
      within(screen.getByTestId("provider-remove-dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId("provider-remove-dialog"),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("provider-remove-open-mcs_01k5s1"));
    await screen.findByTestId("provider-remove-dialog");
    expect(
      screen.queryByTestId("provider-remove-failure"),
    ).not.toBeInTheDocument();
  });

  it("clears the not-found note when the dialog is closed", async () => {
    actions.removeProvider.mockResolvedValue({
      ok: true,
      value: { deleted: false },
    });
    renderProviders();
    fireEvent.click(screen.getByTestId("provider-remove-open-mcs_01k5s1"));
    fireEvent.click(await screen.findByTestId("provider-remove-confirm"));
    await screen.findByTestId("provider-remove-not-found");
    fireEvent.click(
      within(screen.getByTestId("provider-remove-dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId("provider-remove-dialog"),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("provider-remove-open-mcs_01k5s1"));
    await screen.findByTestId("provider-remove-dialog");
    expect(
      screen.queryByTestId("provider-remove-not-found"),
    ).not.toBeInTheDocument();
  });

  it("sends one removal while the first is still answering", async () => {
    let answer: (value: unknown) => void = () => undefined;
    actions.removeProvider.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderProviders();
    fireEvent.click(screen.getByTestId("provider-remove-open-mcs_01k5s1"));
    const confirm = await screen.findByTestId("provider-remove-confirm");
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(confirm).toHaveTextContent("Removing…");
    });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(confirm);
    expect(actions.removeProvider).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: { deleted: false } });
    await screen.findByTestId("provider-remove-not-found");
  });
});

describe("Providers › Re-import", () => {
  it("names a refused re-import where the person acted, and reloads nothing", async () => {
    actions.importTools.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "server_not_found",
    });
    renderProviders();
    const dialog = await openDrill();
    fireEvent.click(dialog.getByTestId("provider-reimport-mcs_01k5s1"));
    expect(
      await screen.findByTestId("provider-reimport-failure"),
    ).toHaveTextContent(failure("serverNotFound"));
    expect(
      screen.queryByTestId("provider-reimport-done"),
    ).not.toBeInTheDocument();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("names a re-import that threw before it answered", async () => {
    actions.importTools.mockRejectedValue(new Error("network"));
    renderProviders();
    const dialog = await openDrill();
    fireEvent.click(dialog.getByTestId("provider-reimport-mcs_01k5s1"));
    expect(
      await screen.findByTestId("provider-reimport-failure"),
    ).toHaveTextContent(failure("unavailable", { code: "action_failed" }));
  });

  it("reloads the tab when a re-import answered, and sends one while it is running", async () => {
    let answer: (value: unknown) => void = () => undefined;
    actions.importTools.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderProviders();
    const dialog = await openDrill();
    const button = dialog.getByTestId("provider-reimport-mcs_01k5s1");
    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toHaveTextContent("Re-importing…");
    });
    fireEvent.click(button);
    expect(actions.importTools).toHaveBeenCalledTimes(1);
    answer({
      ok: true,
      value: { importDigest: "d1", published: 0, unchanged: 0 },
    });
    expect(
      await screen.findByTestId("provider-reimport-done"),
    ).toHaveTextContent("No new version, nothing unchanged.");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});
