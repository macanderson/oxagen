// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "@/test/intl";
import { expectNoAxe } from "@/test/expect-no-axe";
import { readOk, readError } from "@/data/read";
import { RunOutcomesConsent } from "./consent";
const action = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
vi.mock("./actions", () => ({ setRunOutcomesConsentAction: action }));
const off = {
  customerEnabled: false,
  platformDisabled: false,
  platformDisabledReason: null,
  effectiveEnabled: false,
};
const at = { org: "acme", ws: "core" };
afterEach(cleanup);
beforeEach(() => {
  action.mockReset();
  refresh.mockReset();
});
async function show(
  props: Partial<Parameters<typeof RunOutcomesConsent>[0]> = {},
) {
  const view = render(
    <IntlProvider>
      <RunOutcomesConsent at={at} policy={readOk(off)} canManage {...props} />
    </IntlProvider>,
  );
  await expectNoAxe(view.container);
  return view;
}
describe("run follow-through consent", () => {
  it("starts off and requires a click with visible metering disclosure", async () => {
    action.mockResolvedValue({
      ok: true,
      value: { ...off, customerEnabled: true, effectiveEnabled: true },
    });
    await show();
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByText(/Stella model calls are metered/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Enable metered follow-through" }),
    );
    expect(action).toHaveBeenCalledWith(at, true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("button", { name: "Disable follow-through" }),
    ).toBeVisible();
  });
  it("offers no write to a member", async () => {
    await show({ canManage: false });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/Ask an organization owner/)).toBeVisible();
  });
  it("cannot offer enablement while the platform has suspended access", async () => {
    await show({
      policy: readOk({
        ...off,
        platformDisabled: true,
        platformDisabledReason: "Review required",
      }),
    });
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByText("Review required")).toBeVisible();
  });
  it("lets an opted-in customer revoke consent during platform suspension", async () => {
    action.mockResolvedValue({
      ok: true,
      value: { ...off, platformDisabled: true },
    });
    await show({
      policy: readOk({ ...off, customerEnabled: true, platformDisabled: true }),
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Disable follow-through" }),
    );
    expect(action).toHaveBeenCalledWith(at, false);
  });
  it("keeps stored status after a denied write and announces the refusal", async () => {
    action.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "set_run_outcomes_settings",
    });
    await show();
    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An organization owner or admin must change this setting.",
    );
    expect(
      screen.getByRole("button", { name: "Enable metered follow-through" }),
    ).toBeVisible();
  });
  it("renders unavailable reads without a guessed enable action", async () => {
    await show({ policy: readError("run_read_unavailable", 503) });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
