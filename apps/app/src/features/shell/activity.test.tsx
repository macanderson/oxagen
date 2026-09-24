// @vitest-environment jsdom
// The shell's activity: the topbar's approvals and notification badges, the
// idle poll that keeps them current while both drawers are closed, and the
// Approvals and Notifications drawers the badges open, in every state their
// reads can answer.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type Read, readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  ActivityButtons,
  ActivityDrawers,
  ShellActivityProvider,
} from "./activity";
import { shellData } from "./shell.builders";
import { ShellStateProvider, useShellState } from "./shell-state";

const actions = vi.hoisted(() => ({
  readShellActivity: vi.fn(),
  readShellNavCounts: vi.fn(),
  readShellUnreadCount: vi.fn(),
  markShellNotification: vi.fn(),
}));
const nav = vi.hoisted(() => ({ pathname: "/acme/core-platform" }));
vi.mock("./activity-actions", () => actions);
// The panel is Fleet's and has its own tests; this stand-in shows what the
// drawer hands it and lets a test resolve the approval it draws.
vi.mock("@/features/fleet/client", () => ({
  ApprovalsPanel: ({
    ws,
    now,
    approvals,
    mandates,
    onResolved,
  }: {
    ws: string;
    now: number;
    approvals: Read<{ items: { id: string }[]; more: boolean }>;
    mandates: ReadonlyMap<string, unknown>;
    onResolved?: () => void;
  }) => (
    <div data-testid="approvals-panel">
      <p>{`workspace ${ws}`}</p>
      <p>{`now ${String(now)}`}</p>
      <p>{`mandates ${String(mandates.size)}`}</p>
      <p>
        {`items ${approvals.ok ? approvals.value.items.map((i) => i.id).join(",") : "none"}`}
      </p>
      <button type="button" onClick={onResolved}>
        resolve approval
      </button>
    </div>
  ),
}));
vi.mock("next/link", () => ({
  // SafeLink hands next/link a checked path; the stand-in keeps it and stops
  // jsdom's unimplemented navigation.
  default: ({
    children,
    onClick,
    ...rest
  }: {
    children: ReactNode;
    href: string;
    onClick?: () => void;
    className?: string;
  }) => (
    <a
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const ok = <T,>(value: T) => ({ ok: true as const, value });
const navCounts = (approvals: number | null) =>
  ok({ approvals, proposals: null, incidents: null });
const unread = (unreadCount: number) => ok({ notifications: [], unreadCount });
const READ_AT = "2026-09-23T00:00:00Z";

function deferred<T>() {
  const handlers: {
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  } = { resolve: () => undefined, reject: () => undefined };
  const promise = new Promise<T>((resolve, reject) => {
    handlers.resolve = resolve;
    handlers.reject = reject;
  });
  return { promise, ...handlers };
}

type Item = {
  id: string;
  tool: string;
  agentKey: string | null;
  runId: string | null;
};
const item = (id: string, overrides: Partial<Item> = {}): Item => ({
  id,
  tool: `tool.${id}`,
  agentKey: null,
  runId: null,
  ...overrides,
});

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    slug: "core-platform",
    name: "Core platform",
    pending: ok({ items: [item("a1")], more: false }),
    mandates: ok({ mandates: [] }),
    resolved: ok({ items: [], nextCursor: null }),
    ...overrides,
  };
}

type Note = {
  publicId: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  unread: boolean;
  createdAt: string;
};
const note = (
  publicId: string,
  overrides: Partial<Note> = {},
  ws: string | null = null,
) => ({
  notification: {
    publicId,
    title: `Title ${publicId}`,
    body: null,
    deepLink: null,
    unread: false,
    createdAt: READ_AT,
    ...overrides,
  },
  ws,
});

function activity(
  overrides: {
    workspaces?: unknown[];
    notifications?: {
      items: unknown[];
      partial: boolean;
      failures: unknown[];
    };
    readAt?: string;
  } = {},
) {
  return ok({
    workspaces: [workspace()],
    notifications: { items: [], partial: false, failures: [] },
    currentWorkspace: "core-platform",
    readAt: READ_AT,
    ...overrides,
  });
}

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
  nav.pathname = "/acme/core-platform";
  actions.readShellNavCounts.mockResolvedValue(navCounts(3));
  actions.readShellUnreadCount.mockResolvedValue(unread(2));
  actions.readShellActivity.mockResolvedValue(activity());
  actions.markShellNotification.mockResolvedValue(ok({ ok: true }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

function renderButtons(data = shellData()) {
  return render(
    <IntlProvider>
      <ShellStateProvider>
        <ShellActivityProvider data={data}>
          <ActivityButtons />
          <Opener />
        </ShellActivityProvider>
      </ShellStateProvider>
    </IntlProvider>,
  );
}

function renderShell(data = shellData()) {
  return render(
    <IntlProvider>
      <ShellStateProvider>
        <ShellActivityProvider data={data}>
          <ActivityButtons />
          <ActivityDrawers data={data} />
        </ShellActivityProvider>
      </ShellStateProvider>
    </IntlProvider>,
  );
}

/** The topbar button, which the open modal hides from the accessibility tree. */
const approvalsBadge = () =>
  screen.getByRole("button", { name: "Approvals", hidden: true });

async function openApprovals(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Approvals" }));
  return screen.findByTestId("approvals-drawer");
}

async function openNotifications(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Notifications" }));
  return screen.findByTestId("notifications-drawer");
}

async function closeDrawer(
  user: ReturnType<typeof userEvent.setup>,
  drawer: HTMLElement,
) {
  await user.click(within(drawer).getByRole("button", { name: "Close" }));
  await waitFor(() => {
    expect(drawer.isConnected).toBe(false);
  });
}

describe("activity badges with the drawers closed", () => {
  it("show the idle approval count and unread dot without the detailed read", async () => {
    const { container } = renderButtons();
    expect(await screen.findByLabelText("2 unread notifications")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Approvals" }).textContent,
    ).toContain("3");
    expect(actions.readShellActivity).not.toHaveBeenCalled();
    expect(actions.readShellUnreadCount).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    await expectNoAxe(container);
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

  it.each([
    ["refused", readError("control_plane_unavailable", 503)],
    ["not recorded", navCounts(null)],
  ])(
    "show no approval count when the count read is %s",
    async (_label, read) => {
      actions.readShellNavCounts.mockResolvedValue(read);
      renderButtons();
      await screen.findByLabelText("2 unread notifications");
      expect(
        screen.getByRole("button", { name: "Approvals" }).textContent,
      ).toBe("Approvals");
    },
  );

  it("show neither a count nor a dot when both idle reads fail", async () => {
    actions.readShellNavCounts.mockRejectedValue(new Error("offline"));
    actions.readShellUnreadCount.mockRejectedValue(new Error("offline"));
    renderButtons();
    await waitFor(() => {
      expect(actions.readShellUnreadCount).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
    expect(screen.getByRole("button", { name: "Approvals" }).textContent).toBe(
      "Approvals",
    );
  });

  it("show no dot when the unread read is refused", async () => {
    actions.readShellUnreadCount.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "notification.read",
    });
    renderButtons();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Approvals" }).textContent,
      ).toContain("3");
    });
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
  });

  it("read unread at organization scope and skip the count read when no workspace is in view", async () => {
    nav.pathname = "/acme";
    renderButtons(
      shellData({ context: readError("control_plane_unavailable", 503) }),
    );
    expect(await screen.findByLabelText("2 unread notifications")).toBeTruthy();
    expect(actions.readShellUnreadCount).toHaveBeenCalledWith("acme", null);
    expect(actions.readShellNavCounts).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approvals" }).textContent).toBe(
      "Approvals",
    );
  });

  it.each([
    ["the count lands and the unread read fails", "resolve", "reject"],
    ["the count read fails and the unread read lands", "reject", "resolve"],
  ])(
    "stop polling after unmount when %s late",
    async (_label, countOutcome, unreadOutcome) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const count = deferred<unknown>();
      const unreadRead = deferred<unknown>();
      actions.readShellNavCounts.mockReturnValue(count.promise);
      actions.readShellUnreadCount.mockReturnValue(unreadRead.promise);
      const { unmount } = renderButtons();
      unmount();
      await act(async () => {
        if (countOutcome === "resolve") count.resolve(navCounts(9));
        else count.reject(new Error("late"));
        if (unreadOutcome === "resolve") unreadRead.resolve(unread(9));
        else unreadRead.reject(new Error("late"));
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(actions.readShellNavCounts).toHaveBeenCalledTimes(1);
      expect(actions.readShellUnreadCount).toHaveBeenCalledTimes(1);
    },
  );
});

describe("activity outside the activity provider", () => {
  it("draws bare badges and a loading drawer whose Refresh does nothing", async () => {
    const user = userEvent.setup();
    const data = shellData();
    render(
      <IntlProvider>
        <ShellStateProvider>
          <ActivityButtons />
          <ActivityDrawers data={data} />
        </ShellStateProvider>
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: "Approvals" }).textContent).toBe(
      "Approvals",
    );
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
    const drawer = await openApprovals(user);
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
    expect(actions.readShellActivity).not.toHaveBeenCalled();
  });
});

describe("the approvals drawer", () => {
  it("shows loading until the read lands, then each workspace's pending approvals", async () => {
    const user = userEvent.setup();
    const read = deferred<unknown>();
    actions.readShellActivity.mockReturnValue(read.promise);
    renderShell();
    const drawer = await openApprovals(user);
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
    expect(actions.readShellActivity).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    await act(async () => {
      read.resolve(
        activity({
          workspaces: [
            workspace({
              pending: ok({
                items: [
                  item("a1", { agentKey: "deploy-bot", runId: "run_1" }),
                  item("a2", { runId: "run_2" }),
                  item("a3"),
                ],
                more: false,
              }),
              resolved: ok({ items: [{}, {}], nextCursor: "c2" }),
            }),
          ],
        }),
      );
      await Promise.resolve();
    });
    expect(within(drawer).queryByRole("status")).toBeNull();
    expect(
      within(drawer).getByRole("heading", { name: "Core platform" }),
    ).toBeTruthy();
    // Each approval names its agent, else its run, else its own id.
    const label = (tool: RegExp) =>
      within(drawer).getByRole("button", { name: tool }).lastChild?.textContent;
    expect(label(/^tool\.a1/)).toBe("deploy-bot");
    expect(label(/^tool\.a2/)).toBe("run_2");
    expect(label(/^tool\.a3/)).toBe("a3");
    expect(within(drawer).getByText("2 resolved today (UTC)+")).toBeTruthy();
    expect(approvalsBadge().textContent).toBe("Approvals3");
    await expectNoAxe(drawer);
  });

  it("names a workspace it could not read, one with nothing waiting, and one with more than the list holds", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace({
            slug: "billing",
            name: "Billing",
            pending: readError("approvals_unavailable", 503),
            resolved: {
              ok: false,
              reason: "denied",
              permission: "approval.read",
            },
          }),
          workspace({
            slug: "quiet",
            name: "Quiet",
            pending: ok({ items: [], more: false }),
          }),
          workspace({
            slug: "busy",
            name: "Busy",
            pending: ok({ items: [item("b1"), item("b2")], more: true }),
            resolved: ok({ items: [{}], nextCursor: null }),
          }),
        ],
      }),
    );
    renderShell();
    const drawer = await openApprovals(user);
    expect(
      await within(drawer).findByText(
        "Billing could not be loaded: the control plane answered approvals_unavailable. Nothing was changed, and runs kept recording.",
      ),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(
        "You cannot see Resolved approvals in this workspace. Your roles do not include approval.read; an organization owner can grant it.",
      ),
    ).toBeTruthy();
    expect(within(drawer).getByText("No approvals waiting")).toBeTruthy();
    expect(
      within(drawer).getAllByText(
        "More approvals are waiting than this list can show.",
      ),
    ).toHaveLength(1);
    expect(within(drawer).getByText("1 resolved today (UTC)")).toBeTruthy();
    expect(within(drawer).queryByText("No accessible workspaces")).toBeNull();
    // Two listed, and both an unread workspace and a truncated one make it a floor.
    expect(approvalsBadge().textContent).toBe("Approvals2+");
  });

  it("says so when the viewer can reach no workspace", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(activity({ workspaces: [] }));
    renderShell();
    const drawer = await openApprovals(user);
    expect(
      await within(drawer).findByText("No accessible workspaces"),
    ).toBeTruthy();
    expect(approvalsBadge().textContent).toBe("Approvals0");
  });

  it.each([
    [
      "a denial with the permission it needed",
      { ok: false, reason: "denied", code: "approval.read" },
      "You cannot see Approvals in this workspace. Your roles do not include approval.read; an organization owner can grant it.",
    ],
    [
      "an access request still waiting",
      { ok: false, reason: "pending_approval", accessRequestId: "ar_7" },
      "Access to Approvals is waiting for approval, request ar_7.",
    ],
    [
      "any other refusal as the error code",
      { ok: false, reason: "unavailable", code: "control_plane_unavailable" },
      "Approvals could not be loaded: the control plane answered control_plane_unavailable. Nothing was changed, and runs kept recording.",
    ],
  ])("renders %s in both drawers", async (_label, read, text) => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(read);
    renderShell();
    const approvals = await openApprovals(user);
    expect(await within(approvals).findByText(text)).toBeTruthy();
    // A refused detailed read leaves the badge on the idle count.
    expect(approvalsBadge().textContent).toBe("Approvals3");
    await expectNoAxe(approvals);
    await closeDrawer(user, approvals);
    const notifications = await openNotifications(user);
    expect(await within(notifications).findByText(text)).toBeTruthy();
  });

  it("opens one approval in Fleet's panel and returns to the list", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace({
            pending: ok({
              items: [item("a1"), item("a2", { agentKey: "deploy-bot" })],
              more: false,
            }),
            mandates: ok({
              mandates: [{ id: "mdt_1" }, { id: "mdt_2" }],
            }),
          }),
          workspace({
            slug: "billing",
            name: "Billing",
            pending: readError("approvals_unavailable", 503),
          }),
        ],
      }),
    );
    renderShell();
    const drawer = await openApprovals(user);
    await user.click(
      await within(drawer).findByRole("button", { name: /^tool\.a2/ }),
    );
    const panel = within(drawer).getByTestId("approvals-panel");
    expect(within(panel).getByText("workspace core-platform")).toBeTruthy();
    expect(within(panel).getByText("items a2")).toBeTruthy();
    expect(within(panel).getByText("mandates 2")).toBeTruthy();
    expect(
      within(panel).getByText(`now ${String(Date.parse(READ_AT))}`),
    ).toBeTruthy();
    expect(within(drawer).getByText("Core platform")).toBeTruthy();
    expect(
      within(drawer).queryByRole("heading", { name: "Billing" }),
    ).toBeNull();

    await user.click(
      within(panel).getByRole("button", { name: "resolve approval" }),
    );
    await waitFor(() => {
      expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
    });

    await user.click(
      within(drawer).getByRole("button", { name: "All approvals" }),
    );
    expect(within(drawer).queryByTestId("approvals-panel")).toBeNull();
    expect(
      within(drawer).getByRole("heading", { name: "Billing" }),
    ).toBeTruthy();
  });

  it("hands the panel no mandates when the workspace's mandate read failed", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(
      activity({
        workspaces: [
          workspace({ mandates: readError("mandates_unavailable", 503) }),
        ],
      }),
    );
    renderShell();
    const drawer = await openApprovals(user);
    await user.click(
      await within(drawer).findByRole("button", { name: /^tool\.a1/ }),
    );
    expect(within(drawer).getByText("mandates 0")).toBeTruthy();
  });

  it("reports a failed read and clears the report once Refresh succeeds", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockRejectedValueOnce(new Error("offline"));
    renderShell();
    const drawer = await openApprovals(user);
    expect((await within(drawer).findByRole("alert")).textContent).toBe(
      "Activity could not be refreshed. Try again.",
    );
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    expect(
      await within(drawer).findByRole("button", { name: /^tool\.a1/ }),
    ).toBeTruthy();
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("keeps the newest read when an earlier one answers after it", async () => {
    const user = userEvent.setup();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    actions.readShellActivity
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderShell();
    const drawer = await openApprovals(user);
    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    await act(async () => {
      second.resolve(
        activity({
          workspaces: [
            workspace({ pending: ok({ items: [item("new")], more: false }) }),
          ],
        }),
      );
      await Promise.resolve();
    });
    expect(
      await within(drawer).findByRole("button", { name: /^tool\.new/ }),
    ).toBeTruthy();
    await act(async () => {
      first.resolve(
        activity({
          workspaces: [
            workspace({ pending: ok({ items: [item("old")], more: false }) }),
          ],
        }),
      );
      await Promise.resolve();
    });
    expect(
      within(drawer).queryByRole("button", { name: /^tool\.old/ }),
    ).toBeNull();
    expect(
      within(drawer).getByRole("button", { name: /^tool\.new/ }),
    ).toBeTruthy();
  });

  it("ignores a failure from a read the newer read replaced", async () => {
    const user = userEvent.setup();
    const first = deferred<unknown>();
    actions.readShellActivity.mockReturnValueOnce(first.promise);
    renderShell();
    const drawer = await openApprovals(user);
    await user.click(within(drawer).getByRole("button", { name: "Refresh" }));
    expect(
      await within(drawer).findByRole("button", { name: /^tool\.a1/ }),
    ).toBeTruthy();
    await act(async () => {
      first.reject(new Error("late"));
      await Promise.resolve();
    });
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("re-reads every 30 seconds while open and stops when it closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderShell();
    const drawer = await openApprovals(user);
    await within(drawer).findByRole("button", { name: /^tool\.a1/ });
    expect(actions.readShellActivity).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
    await closeDrawer(user, drawer);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an answer", "resolve"],
    ["a failure", "reject"],
  ])(
    "discards %s that lands after the drawer closed",
    async (_label, outcome) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const late = deferred<unknown>();
      const reopened = deferred<unknown>();
      actions.readShellActivity
        .mockReturnValueOnce(late.promise)
        .mockReturnValueOnce(reopened.promise);
      renderShell();
      const drawer = await openApprovals(user);
      await closeDrawer(user, drawer);
      await act(async () => {
        if (outcome === "resolve") late.resolve(activity());
        else late.reject(new Error("late"));
        await vi.advanceTimersByTimeAsync(60_000);
      });
      // No poll was scheduled from the closed drawer's read.
      expect(actions.readShellActivity).toHaveBeenCalledTimes(1);
      const again = await openApprovals(user);
      expect(within(again).getByRole("status").textContent).toBe(
        "Loading activity",
      );
      expect(within(again).queryByRole("alert")).toBeNull();
      expect(
        within(again).queryByRole("button", { name: /^tool\.a1/ }),
      ).toBeNull();
    },
  );
});

describe("the notifications drawer", () => {
  it("lists each notification with its body, link and actions", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [
            note(
              "ntf_1",
              {
                title: "Budget reached",
                body: "deploy-bot spent its daily budget.",
                deepLink: "/acme/core-platform/spend",
                unread: true,
              },
              "core-platform",
            ),
            note("ntf_2", {
              title: "Invitation accepted",
              deepLink: "https://evil.example/phish",
            }),
          ],
          partial: false,
          failures: [],
        },
      }),
    );
    renderShell();
    const drawer = await openNotifications(user);
    const items = await within(drawer).findAllByRole("listitem");
    expect(items).toHaveLength(2);
    const [budget, invitation] = items;
    if (!budget || !invitation) throw new Error("expected two notifications");

    expect(
      within(budget).getByRole("heading", { name: "Budget reached" }),
    ).toBeTruthy();
    expect(
      within(budget).getByText("deploy-bot spent its daily budget."),
    ).toBeTruthy();
    expect(
      within(budget).getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/acme/core-platform/spend");
    expect(
      within(budget).getByRole("button", { name: "Mark read" }),
    ).toBeTruthy();
    expect(
      within(budget).getByRole("button", { name: "Archive" }),
    ).toBeTruthy();

    // A link that leaves the app falls back to the organization page.
    expect(
      within(invitation)
        .getByRole("link", { name: "Open" })
        .getAttribute("href"),
    ).toBe("/acme");
    expect(
      within(invitation).queryByRole("button", { name: "Mark read" }),
    ).toBeNull();
    expect(within(drawer).queryByText("No notifications")).toBeNull();
    expect(
      within(drawer).queryByText(/Some notifications are unavailable/),
    ).toBeNull();
    // The open drawer's read drives the dot: one unread item.
    expect(
      screen.getByLabelText("1 unread notifications", { selector: "span" }),
    ).toBeTruthy();
    await expectNoAxe(drawer);
  });

  it("omits the body and link a notification does not carry", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [note("ntf_3", { title: "Run finished" })],
          partial: false,
          failures: [],
        },
      }),
    );
    renderShell();
    const drawer = await openNotifications(user);
    const entry = await within(drawer).findByRole("listitem");
    expect(within(entry).queryByRole("link")).toBeNull();
    expect(within(entry).queryAllByText(/.+/, { selector: "p" })).toHaveLength(
      0,
    );
    expect(within(entry).getByRole("button", { name: "Archive" })).toBeTruthy();
  });

  it("names the scopes it could not read and says the list is partial", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [],
          partial: true,
          failures: [
            { ws: null, read: readError("notifications_unavailable", 503) },
            {
              ws: "billing",
              read: {
                ok: false,
                reason: "pending_approval",
                accessRequestId: "ar_9",
              },
            },
          ],
        },
      }),
    );
    renderShell();
    const drawer = await openNotifications(user);
    expect(
      await within(drawer).findByText(
        "Notifications could not be loaded: the control plane answered notifications_unavailable. Nothing was changed, and runs kept recording.",
      ),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(
        "Access to billing is waiting for approval, request ar_9.",
      ),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(
        "Some notifications are unavailable or outside this page. Counts cover the loaded records.",
      ),
    ).toBeTruthy();
    expect(within(drawer).getByText("No notifications")).toBeTruthy();
    expect(screen.queryByLabelText(/unread notifications/)).toBeNull();
  });

  it("shows loading before the read lands", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockReturnValue(new Promise(() => undefined));
    renderShell();
    const drawer = await openNotifications(user);
    expect(within(drawer).getByRole("status").textContent).toBe(
      "Loading activity",
    );
  });

  it("marks a notification read in its own workspace, holding both actions until it answers", async () => {
    const user = userEvent.setup();
    const answer = deferred<unknown>();
    actions.markShellNotification.mockReturnValue(answer.promise);
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [note("ntf_1", { unread: true }, "core-platform")],
          partial: false,
          failures: [],
        },
      }),
    );
    renderShell();
    const drawer = await openNotifications(user);
    await user.click(
      await within(drawer).findByRole("button", { name: "Mark read" }),
    );
    expect(actions.markShellNotification).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "ntf_1",
      false,
    );
    expect(
      within(drawer).getByRole("button", { name: "Mark read" }),
    ).toBeDisabled();
    expect(
      within(drawer).getByRole("button", { name: "Archive" }),
    ).toBeDisabled();
    await act(async () => {
      answer.resolve(ok({ ok: true }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        within(drawer).getByRole("button", { name: "Archive" }),
      ).toBeEnabled();
    });
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("archives an organization notification at organization scope", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [note("ntf_4")],
          partial: false,
          failures: [],
        },
      }),
    );
    renderShell();
    const drawer = await openNotifications(user);
    await user.click(
      await within(drawer).findByRole("button", { name: "Archive" }),
    );
    expect(actions.markShellNotification).toHaveBeenCalledWith(
      "acme",
      null,
      "ntf_4",
      true,
    );
    await waitFor(() => {
      expect(actions.readShellActivity).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    [
      "the action is refused",
      () => {
        actions.markShellNotification.mockResolvedValue({
          ok: false,
          reason: "denied",
          code: "notification.write",
        });
      },
    ],
    [
      "the store reports it did not mark",
      () => {
        actions.markShellNotification.mockResolvedValue(ok({ ok: false }));
      },
    ],
    [
      "the action throws",
      () => {
        actions.markShellNotification.mockRejectedValue(new Error("offline"));
      },
    ],
  ])("reports a failed mark when %s", async (_label, arrange) => {
    arrange();
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [note("ntf_5", { unread: true })],
          partial: false,
          failures: [],
        },
      }),
    );
    renderShell();
    const drawer = await openNotifications(user);
    await user.click(
      await within(drawer).findByRole("button", { name: "Mark read" }),
    );
    expect((await within(drawer).findByRole("alert")).textContent).toBe(
      "Activity could not be refreshed. Try again.",
    );
    expect(actions.readShellActivity).toHaveBeenCalledTimes(1);
    expect(
      within(drawer).getByRole("button", { name: "Mark read" }),
    ).toBeEnabled();
  });

  it("closes the drawer when a notification's link is followed", async () => {
    const user = userEvent.setup();
    actions.readShellActivity.mockResolvedValue(
      activity({
        notifications: {
          items: [note("ntf_6", { deepLink: "/acme/core-platform/runs/r1" })],
          partial: false,
          failures: [],
        },
      }),
    );
    renderShell();
    const drawer = await openNotifications(user);
    await user.click(await within(drawer).findByRole("link", { name: "Open" }));
    await waitFor(() => {
      expect(drawer.isConnected).toBe(false);
    });
  });
});
