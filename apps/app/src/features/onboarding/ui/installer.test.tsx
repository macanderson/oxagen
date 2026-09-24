// @vitest-environment jsdom
// The installer's own screens: Download with its facts in order and the
// package's not-published words, Install walking the eight steps to Connected,
// the switch row with aria-pressed, Connected reading the record or saying the
// host is not connected, and the rejected-token screen with no switch row.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { InstallerScreens, INSTALL_STEP_MS } = await import("./installer");

const WRAP = routes.welcome("aintel", "core", "wrap");
const RUN = routes.welcome("aintel", "core", "run");

function renderScreens(
  props: Partial<Parameters<typeof InstallerScreens>[0]> = {},
): void {
  render(
    <IntlProvider>
      <InstallerScreens
        org="Anderson Intelligence Corp."
        workspace="Core platform"
        agentKey="aintel.core.release-manager"
        connected={null}
        rejected={null}
        wrap={WRAP}
        run={RUN}
        {...props}
      />
    </IntlProvider>,
  );
}

const pressed = () =>
  within(screen.getByRole("group", { name: "Installer screen" }))
    .getAllByRole("button")
    .map((b) => [b.textContent, b.getAttribute("aria-pressed")]);

afterEach(async () => {
  vi.useRealTimers();
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("InstallerScreens", () => {
  it("opens on Download: no h1, the card header, the facts in order, Install gold and Cancel back to wrap", () => {
    renderScreens();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(
      screen.getByRole("heading", { level: 3, name: "Oxagen Agent Installer" }),
    ).toBeInTheDocument();
    const download = screen.getByTestId("installer-download");
    expect(
      within(download).getByRole("heading", {
        level: 2,
        name: "Install the Oxagen agent",
      }),
    ).toBeInTheDocument();
    expect(download).toHaveTextContent(
      "then enrolls this host to Anderson Intelligence Corp. / Core platform.",
    );
    expect(
      [...download.querySelectorAll("dt")].map((dt) => dt.textContent),
    ).toEqual(["Package", "Size", "Signature", "Checksum", "Token"]);
    expect(screen.getByTestId("installer-package")).toHaveTextContent(
      "not published yet",
    );
    expect(screen.getByRole("button", { name: "Install" }).className).toContain(
      "bg-button-primary-bg",
    );
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      WRAP,
    );
    expect(download).toHaveTextContent(
      "Installs to your user account only. No sudo, no kernel extension, and nothing leaves the host except frames.",
    );
    expect(pressed()).toEqual([
      ["Download", "true"],
      ["Installing", "false"],
      ["Connected", "false"],
    ]);
  });

  it("Install walks the eight steps with no action, then lands on Connected", () => {
    vi.useFakeTimers();
    renderScreens();
    act(() => {
      screen.getByRole("button", { name: "Install" }).click();
    });
    const installing = screen.getByTestId("installer-installing");
    expect(installing).toHaveTextContent("Step 1 of 8");
    expect(within(installing).queryAllByRole("button")).toHaveLength(0);
    const steps = [...installing.querySelectorAll("li")];
    expect(steps).toHaveLength(8);
    expect(steps[0]).toHaveAttribute("data-state", "now");
    expect(steps[7]).toHaveTextContent("Run a one-turn smoke session");
    const tick = (n: number) => {
      for (let i = 0; i < n; i++)
        act(() => {
          vi.advanceTimersByTime(INSTALL_STEP_MS);
        });
    };
    tick(3);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "3",
    );
    expect(screen.getByTestId("installer-installing")).toHaveTextContent(
      "Step 4 of 8",
    );
    tick(5);
    expect(screen.getByTestId("installer-connected")).toBeInTheDocument();
    expect(pressed()[2]).toEqual(["Connected", "true"]);
  });

  it("Connected reads the record: the first frame and its run, and Back to Oxagen to Start a run", () => {
    renderScreens({
      connected: { at: "2026-09-23T14:02:11.000Z", runId: "run_01" },
    });
    act(() => {
      screen.getByRole("button", { name: "Connected" }).click();
    });
    const connected = screen.getByTestId("installer-connected");
    expect(
      within(connected).getByRole("heading", {
        level: 2,
        name: "Connected to Anderson Intelligence Corp.",
      }),
    ).toBeInTheDocument();
    expect(connected).toHaveTextContent("connected");
    expect(connected).toHaveTextContent(
      "aintel.core.release-manager is wrapped.",
    );
    expect(connected).toHaveTextContent("run run_01 · countersigned on ingest");
    expect(connected).toHaveTextContent("tacho unenroll");
    expect(
      within(connected).getByRole("link", { name: "Back to Oxagen" }),
    ).toHaveAttribute("href", RUN);
    expect(connected).toHaveTextContent(
      "The operator console is already unlocking in your browser.",
    );
  });

  it("Connected before any frame says the host is not connected rather than drawing one", () => {
    renderScreens();
    act(() => {
      screen.getByRole("button", { name: "Connected" }).click();
    });
    const connected = screen.getByTestId("installer-connected");
    expect(connected).toHaveTextContent("Not connected yet");
    expect(connected).not.toHaveTextContent("countersigned on ingest");
  });

  it("a rejected token replaces the card body, hides the switch row and has no gold action", () => {
    renderScreens({
      rejected: {
        token: "oxe_1time_7qk4m2nv9xr3t8zp7qk4m2nv9x",
        at: "2026-09-11T13:58:00.000Z",
        host: "mbp-marcus",
      },
    });
    const rejected = screen.getByTestId("installer-rejected");
    expect(
      within(rejected).getByRole("heading", {
        level: 2,
        name: "Enrollment token rejected",
      }),
    ).toBeInTheDocument();
    expect(rejected).toHaveTextContent("Enrollment tokens are single use.");
    expect(rejected).toHaveTextContent(
      "Nothing was installed. Generate a fresh token from the wrap step and run the installer again.",
    );
    expect(
      within(rejected).getByRole("link", { name: "Back to wrap an agent" }),
    ).toHaveAttribute("href", WRAP);
    expect(
      screen.queryByRole("group", { name: "Installer screen" }),
    ).toBeNull();
    expect(
      [...document.querySelectorAll("a, button")].filter((el) =>
        el.className.includes("bg-button-primary-bg"),
      ),
    ).toHaveLength(0);
  });
});
