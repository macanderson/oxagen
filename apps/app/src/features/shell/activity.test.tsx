// @vitest-environment jsdom
// The topbar's approvals and notification badges while both drawers are
// closed: they read the idle poll, never the drawer's read across every
// workspace, and a detailed value left from an earlier opening does not freeze
// them.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import shellMessages from "../../../messages/shell.json";
import { expectNoAxe } from "@/test/expect-no-axe";
import { ActivityButtons, ShellActivityProvider } from "./activity";
import { shellData } from "./shell.builders";
import { ShellStateProvider, useShellState } from "./shell-state";

const actions = vi.hoisted(() => ({
  readShellActivity: vi.fn(),
  readShellNavCounts: vi.fn(),
  readShellUnreadCount: vi.fn(),
  markShellNotification: vi.fn(),
}));
vi.mock("./activity-actions", () => actions);
vi.mock("@/features/fleet/client", () => ({ ApprovalsPanel: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core-platform",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const ok = <T,>(value: T) => ({ ok: true as const, value });
const navCounts = (approvals: number | null) =>
  ok({ approvals, proposals: null, incidents: null });
const unread = (unreadCount: number) => ok({ notifications: [], unreadCount });

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  vi.resetAllMocks();
  actions.readShellNavCounts.mockResolvedValue(navCounts(3));
  actions.readShellUnreadCount.mockResolvedValue(unread(2));
  actions.readShellActivity.mockResolvedValue(
    ok({
      workspaces: [
        {
          slug: "core-platform",
          name: "Core platform",
          pending: ok({ items: [{ id: "a" }], more: false }),
        },
      ],
      notifications: { items: [], partial: false, failures: [] },
      currentWorkspace: "core-platform",
      readAt: "2026-09-23T00:00:00Z",
    }),
  );
});

// INV-26: every test ends in a state axe accepts, then unmounts.
afterEach(async () => {
  vi.useRealTimers();
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function Opener() {
  const { setApprovalsOpen } = useShellState();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setApprovalsOpen(true);
        }}
      >
        open drawer
      </button>
      <button
        type="button"
        onClick={() => {
          setApprovalsOpen(false);
        }}
      >
        close drawer
      </button>
    </>
  );
}

function renderButtons() {
  return render(
    <NextIntlClientProvider locale="en" messages={shellMessages}>
      <ShellStateProvider>
        <ShellActivityProvider data={shellData()}>
          <ActivityButtons />
          <Opener />
        </ShellActivityProvider>
      </ShellStateProvider>
    </NextIntlClientProvider>,
  );
}

describe("activity badges with the drawers closed", () => {
  it("show the idle approval count and unread dot without the detailed read", async () => {
    renderButtons();
    expect(await screen.findByLabelText("2 unread notifications")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approvals" }).textContent,
    ).toContain("3");
    expect(actions.readShellActivity).not.toHaveBeenCalled();
    expect(actions.readShellUnreadCount).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
  });

  it("render no dot when nothing is unread", async () => {
    actions.readShellUnreadCount.mockResolvedValue(unread(0));
    renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
  });

  it("return to the idle poll after a drawer closes instead of freezing on the detailed read", async () => {
    const user = userEvent.setup();
    renderButtons();
    await screen.findByLabelText("2 unread notifications");

    await user.click(screen.getByRole("button", { name: "open drawer" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Approvals" }).textContent,
      ).toContain("1");
    });

    await user.click(screen.getByRole("button", { name: "close drawer" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Approvals" }).textContent,
      ).toContain("3");
    });
    expect(screen.getByLabelText("2 unread notifications")).toBeTruthy();
  });

  it("pick up new activity on the next idle poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderButtons();
    await screen.findByLabelText("2 unread notifications");
    actions.readShellUnreadCount.mockResolvedValue(unread(5));
    actions.readShellNavCounts.mockResolvedValue(navCounts(4));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(await screen.findByLabelText("5 unread notifications")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approvals" }).textContent,
    ).toContain("4");
    expect(actions.readShellActivity).not.toHaveBeenCalled();
  });
});
