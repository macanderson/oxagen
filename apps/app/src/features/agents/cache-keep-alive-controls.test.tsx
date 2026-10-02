// @vitest-environment jsdom
// The cache keep-alive switch on the Overview tab (lane F32): one button that
// turns the setting the other way, by the agent's slug, and re-reads the page
// once the write answers. A refusal is named under the button and nothing
// re-reads. Axe runs after every test (INV-26).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, setAgentCacheKeepAlive } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  setAgentCacheKeepAlive: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ setAgentCacheKeepAlive }));

const { KeepAliveToggle } = await import("./cache-keep-alive-controls");
type KeepAliveTarget = ComponentProps<typeof KeepAliveToggle>;

const TARGET: KeepAliveTarget = {
  org: "acme",
  ws: "core-platform",
  agentSlug: "release-bot",
  on: true,
};

function renderToggle(over: Partial<KeepAliveTarget> = {}) {
  render(
    <IntlProvider>
      <KeepAliveToggle {...TARGET} {...over} />
    </IntlProvider>,
  );
}

beforeEach(() => {
  router.refresh.mockReset();
  setAgentCacheKeepAlive.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("KeepAliveToggle", () => {
  it("turns an agent's keep-alive off and re-reads the page", async () => {
    setAgentCacheKeepAlive.mockResolvedValue({
      ok: true,
      value: { cacheKeepAlive: false },
    });
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(setAgentCacheKeepAlive).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "release-bot",
      false,
    );
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("agent-keep-alive-failure")).toBeNull();
  });

  it("turns an agent's keep-alive back on", async () => {
    setAgentCacheKeepAlive.mockResolvedValue({
      ok: true,
      value: { cacheKeepAlive: true },
    });
    renderToggle({ on: false });
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(setAgentCacheKeepAlive).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "release-bot",
      true,
    );
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("says only an org Owner or Admin can change it when the write is denied (negative)", async () => {
    setAgentCacheKeepAlive.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(
      await screen.findByTestId("agent-keep-alive-failure"),
    ).toHaveTextContent(
      "The keep-alive setting did not change. Only an org Owner or Admin can change it.",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("says the setting did not change when the write fails another way (negative)", async () => {
    setAgentCacheKeepAlive.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "agent_not_found",
    });
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(
      await screen.findByTestId("agent-keep-alive-failure"),
    ).toHaveTextContent(
      "The keep-alive setting did not change. Reload the page and try again.",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("says the setting did not change when the write never answered (negative)", async () => {
    setAgentCacheKeepAlive.mockRejectedValue(new Error("socket closed"));
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(
      await screen.findByTestId("agent-keep-alive-failure"),
    ).toHaveTextContent("The keep-alive setting did not change.");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("sends one write however often it is clicked while pending (negative)", async () => {
    setAgentCacheKeepAlive.mockReturnValue(new Promise(() => undefined));
    renderToggle();
    const button = screen.getByRole("button", { name: "Turn off" });
    await userEvent.click(button);
    expect(button).toHaveTextContent("Turning off");
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    expect(setAgentCacheKeepAlive).toHaveBeenCalledTimes(1);
  });
});
