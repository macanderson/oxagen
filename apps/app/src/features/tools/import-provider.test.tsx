// @vitest-environment jsdom
// The import dialog's paths that write-controls.test.tsx does not walk: an
// auth config typed for a bearer or header provider, and the one that is
// refused before it is sent; a connect that threw; a provider that listed
// nothing; the Back buttons; closing the dialog midway, which starts the next
// one at Connect; the filter over a long list; and the receipt that leaves the confirm button inert. The
// auth config is secret material, so the tests also check it never comes
// back into the dialog. axe checks the state each test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

const { router, importTools, registerServer, chooseServerTools } = vi.hoisted(
  () => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    importTools: vi.fn(),
    registerServer: vi.fn(),
    chooseServerTools: vi.fn(() =>
      Promise.resolve({ ok: true, value: { options: [], partial: false } }),
    ),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ importTools, registerServer }));
vi.mock("@/features/shell/client", () => ({ chooseServerTools }));

const { ImportProvider } = await import("./import-provider");

const at = { org: "acme", ws: "core-platform" };
const ROSTER = [
  { id: "mcs_01k5s1", name: "Stripe" },
  { id: "mcs_01k5s2", name: "GitHub" },
];
const failure = translator("tools.actions.failure");
const t = translator("tools.import");

function element(node: Element | null | undefined, what: string): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`no ${what}`);
  return node;
}
const formOf = (node: HTMLElement) => element(node.closest("form"), "form");

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

type Props = Partial<Parameters<typeof ImportProvider>[0]>;

function open(props: Props = {}) {
  const view = render(
    <IntlProvider>
      <ImportProvider at={at} servers={ROSTER} {...props} />
    </IntlProvider>,
  );
  fireEvent.click(screen.getByTestId("tools-import-open"));
  return view;
}

/** Name and endpoint for a new provider, the two fields every connect needs. */
function describeNew() {
  fill("Name", "Notion");
  fill("Endpoint URL", "https://mcp.notion.example/v1");
}

const connectForm = () => formOf(screen.getByLabelText("Provider"));

function registered(discoveredTools: readonly string[]) {
  return {
    ok: true,
    value: {
      serverId: "mcs_01k5s9",
      healthStatus: "healthy",
      discoveredTools,
    },
  };
}

/** The step the dialog marks as current. */
function currentStep(): string | null {
  const steps = screen.getByRole("list", { name: t("steps.label") });
  return (
    within(steps)
      .getAllByRole("listitem")
      .find((item) => item.getAttribute("aria-current") === "step")
      ?.textContent ?? null
  );
}

beforeEach(() => {
  for (const fn of [
    router.refresh,
    router.replace,
    importTools,
    registerServer,
  ]) {
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

describe("ImportProvider › trigger", () => {
  it("reads Add a provider where it is the Providers tab's action", () => {
    render(
      <IntlProvider>
        <ImportProvider at={at} servers={ROSTER} label="add" primary />
      </IntlProvider>,
    );
    expect(screen.getByTestId("tools-import-open")).toHaveTextContent(
      t("openAdd"),
    );
  });

  it("offers only a new provider when the roster read failed", () => {
    open({ servers: null });
    const picker = screen.getByLabelText("Provider");
    expect(
      [...picker.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual([t("newProvider")]);
  });
});

describe("ImportProvider › auth", () => {
  it("asks for no auth config until a strategy needs one", () => {
    open();
    expect(screen.queryByLabelText("Auth config")).not.toBeInTheDocument();
    fill("Auth", "bearer");
    expect(screen.getByLabelText("Auth config")).toBeRequired();
    fill("Auth", "none");
    expect(screen.queryByLabelText("Auth config")).not.toBeInTheDocument();
  });

  it("sends a bearer provider's config as the pairs typed, and never shows it again", async () => {
    registerServer.mockResolvedValue(registered(["get_page"]));
    open();
    describeNew();
    fill("Auth", "bearer");
    fill("Auth config", "token = sk-live-secret");
    fireEvent.submit(connectForm());
    await waitFor(() => {
      expect(registerServer).toHaveBeenCalledWith("acme", "core-platform", {
        name: "Notion",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.notion.example/v1",
        authStrategy: "bearer",
        authConfig: { token: "sk-live-secret" },
      });
    });
    await screen.findByTestId("tools-import-selected");
    expect(document.body.textContent).not.toContain("sk-live-secret");
  });

  it.each<[string, string]>([
    ["a line with no equals sign", "sk-live-secret"],
    ["a name with no value", "token ="],
    ["the same name twice", "X-Api-Key = a\nX-Api-Key = b"],
  ])(
    "refuses %s before anything is sent, and does not echo it",
    (_case, config) => {
      open();
      describeNew();
      fill("Auth", "header");
      fill("Auth config", config);
      fireEvent.submit(connectForm());
      expect(screen.getByTestId("tools-import-failure")).toHaveTextContent(
        failure("invalid"),
      );
      expect(
        screen.getByTestId("tools-import-failure").textContent,
      ).not.toContain("secret");
      expect(registerServer).not.toHaveBeenCalled();
      expect(currentStep()).toBe(t("steps.s1"));
    },
  );
});

describe("ImportProvider › connect", () => {
  it("names a connect that threw before it answered, and stays on Connect", async () => {
    registerServer.mockRejectedValue(new Error("network"));
    open();
    describeNew();
    fireEvent.submit(connectForm());
    expect(await screen.findByTestId("tools-import-failure")).toHaveTextContent(
      failure("unavailable", { code: "action_failed" }),
    );
    expect(currentStep()).toBe(t("steps.s1"));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("sends one connect while the first is still answering", async () => {
    let answer: (value: unknown) => void = () => undefined;
    registerServer.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    open();
    describeNew();
    fireEvent.submit(connectForm());
    await waitFor(() => {
      expect(screen.getByTestId("tools-import-connect")).toHaveTextContent(
        t("pending"),
      );
    });
    fireEvent.submit(connectForm());
    expect(registerServer).toHaveBeenCalledTimes(1);
    answer(registered([]));
    await screen.findByText(t("nothingListed"));
  });

  it("moves nowhere when the provider picked has left the roster", () => {
    const view = open();
    fill("Provider", "mcs_01k5s2");
    // The page re-read its roster behind the dialog and GitHub is gone.
    view.rerender(
      <IntlProvider>
        <ImportProvider at={at} servers={ROSTER.slice(0, 1)} />
      </IntlProvider>,
    );
    fireEvent.submit(connectForm());
    expect(currentStep()).toBe(t("steps.s1"));
    expect(importTools).not.toHaveBeenCalled();
  });
});

describe("ImportProvider › review and classify", () => {
  it("says a provider that listed nothing has nothing to import, and offers no Classify", async () => {
    registerServer.mockResolvedValue(registered([]));
    open();
    describeNew();
    fireEvent.submit(connectForm());
    expect(await screen.findByText(t("nothingListed"))).toBeVisible();
    expect(screen.getByText("0 tools listed by Notion")).toBeVisible();
    // A listed provider imports what is checked, and an empty list has
    // nothing to check: import every pin is the roster path's, not this one's.
    expect(screen.getByTestId("tools-import-classify")).toBeDisabled();
    expect(
      screen.queryByTestId("tools-import-selected"),
    ).not.toBeInTheDocument();
  });

  it("puts a tool back when its box is checked again", async () => {
    registerServer.mockResolvedValue(registered(["get_page", "create_page"]));
    open();
    describeNew();
    fireEvent.submit(connectForm());
    const box = await screen.findByRole("checkbox", { name: "create_page" });
    fireEvent.click(box);
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.getByTestId("tools-import-selected")).toHaveTextContent(
      "2 of 2 selected",
    );
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    expect(screen.getByTestId("tools-import-confirm")).toHaveTextContent(
      "Import 2 tools",
    );
  });

  it("narrows a long list by the filter and keeps the count over every tool", async () => {
    registerServer.mockResolvedValue(
      registered(["get_page", "create_page", "list_users"]),
    );
    open();
    describeNew();
    fireEvent.submit(connectForm());
    await screen.findByRole("checkbox", { name: "list_users" });
    fill(t("filter"), "PAGE");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(
      screen.queryByRole("checkbox", { name: "list_users" }),
    ).not.toBeInTheDocument();
    // A hidden tool stays checked: the filter changes what is shown, not
    // what is imported.
    expect(screen.getByTestId("tools-import-selected")).toHaveTextContent(
      "3 of 3 selected",
    );
  });

  it("goes back a step from Classify and from Review, keeping what was chosen", () => {
    open();
    fill("Provider", "mcs_01k5s1");
    fireEvent.submit(connectForm());
    fill("Tools", "list_refunds,");
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    expect(currentStep()).toBe(t("steps.s3"));
    fireEvent.click(screen.getByRole("button", { name: t("back") }));
    expect(currentStep()).toBe(t("steps.s2"));
    expect(
      screen.getByRole("button", { name: "Remove list_refunds" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: t("back") }));
    expect(currentStep()).toBe(t("steps.s1"));
    expect(screen.getByLabelText("Provider")).toHaveValue("mcs_01k5s1");
  });

  it("leaves the confirm button inert once the import answered", async () => {
    importTools.mockResolvedValue({
      ok: true,
      value: { importDigest: "d1", published: 1, unchanged: 0 },
    });
    open();
    fill("Provider", "mcs_01k5s1");
    fireEvent.submit(connectForm());
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    const confirm = screen.getByTestId("tools-import-confirm");
    fireEvent.click(confirm);
    await screen.findByTestId("tools-import-done");
    expect(confirm).toHaveAttribute("aria-disabled", "true");
  });

  it("sends one import while the first is still answering", async () => {
    let answer: (value: unknown) => void = () => undefined;
    importTools.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    open();
    fill("Provider", "mcs_01k5s1");
    fireEvent.submit(connectForm());
    fireEvent.click(screen.getByTestId("tools-import-classify"));
    const confirm = screen.getByTestId("tools-import-confirm");
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(confirm).toHaveTextContent(t("importing"));
    });
    fireEvent.click(confirm);
    expect(importTools).toHaveBeenCalledTimes(1);
    answer({
      ok: true,
      value: { importDigest: "d1", published: 1, unchanged: 0 },
    });
    await screen.findByTestId("tools-import-done");
  });
});

describe("ImportProvider › closing", () => {
  it("starts again at Connect with nothing carried over when the dialog is closed midway", async () => {
    registerServer.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    open();
    describeNew();
    fill("Auth", "bearer");
    fill("Auth config", "token = sk-live-secret");
    fireEvent.submit(connectForm());
    await screen.findByTestId("tools-import-failure");
    fireEvent.click(screen.getByRole("button", { name: t("cancel") }));
    await waitFor(() => {
      expect(
        screen.queryByTestId("tools-import-dialog"),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("tools-import-open"));
    await screen.findByTestId("tools-import-dialog");
    expect(currentStep()).toBe(t("steps.s1"));
    expect(
      screen.queryByTestId("tools-import-failure"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Auth")).toHaveValue("none");
    expect(screen.queryByLabelText("Auth config")).not.toBeInTheDocument();
  });
});
