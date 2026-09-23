// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "@/test/intl";
import { expectNoAxe } from "@/test/expect-no-axe";
const mocks = vi.hoisted(() => ({ load: vi.fn(), authorize: vi.fn() }));
vi.mock("./provider-actions", () => ({
  loadRunIssueProviders: mocks.load,
  authorizeRunIssues: mocks.authorize,
}));
import { RunIssueConnections } from "./connections";
const value = {
  github: {
    connected: false,
    connectUrl: "https://github.com/login/oauth/authorize?state=s",
    installUrl: null,
    manageUrl: null,
  },
  linear: {
    configured: true,
    connections: [],
    teams: [],
    hasNextPage: false,
    endCursor: null,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({ ok: true, value });
  mocks.authorize.mockResolvedValue({
    ok: false,
    reason: "denied",
    code: "forbidden",
  });
});
afterEach(cleanup);
async function show(enabled = true, canManage = true) {
  const view = render(
    <IntlProvider>
      <RunIssueConnections
        at={{ org: "acme", ws: "core" }}
        runId="run_one"
        enabled={enabled}
        canManage={canManage}
      />
    </IntlProvider>,
  );
  await expectNoAxe(view.container);
  return view;
}
describe("issue provider authorization", () => {
  it("shows real provider doors after an explicit connection read", async () => {
    await show();
    expect(mocks.load).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Check issue connections" }),
    );
    expect(
      await screen.findByRole("link", { name: "Authorize GitHub" }),
    ).toHaveAttribute("href", value.github.connectUrl);
    await userEvent.click(
      screen.getByRole("button", { name: "Authorize Linear" }),
    );
    expect(mocks.authorize).toHaveBeenCalledWith(
      { org: "acme", ws: "core" },
      "run_one",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Authorization could not start",
    );
  });
  it("does not offer authorization without explicit consent", async () => {
    await show(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Check issue connections" }),
    );
    expect(
      await screen.findByRole("button", { name: "Authorize Linear" }),
    ).toBeDisabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("shows unavailable providers and an empty connection list honestly", async () => {
    mocks.load.mockResolvedValue({
      ok: true,
      value: {
        ...value,
        github: {
          connected: false,
          connectUrl: null,
          installUrl: null,
          manageUrl: null,
        },
        linear: { ...value.linear, configured: false },
      },
    });
    await show();
    await userEvent.click(
      screen.getByRole("button", { name: "Check issue connections" }),
    );
    expect(
      await screen.findByText(
        "Linear authorization is not configured for this deployment.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("No Linear issue connection is recorded."),
    ).toBeVisible();
  });
  it("keeps read failures actionable and members read-only", async () => {
    mocks.load.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "get_run_issue_providers",
    });
    await show();
    await userEvent.click(
      screen.getByRole("button", { name: "Check issue connections" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be read",
    );
    cleanup();
    await show(true, false);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
