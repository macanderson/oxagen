// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "@/test/intl";
const { write, refresh } = vi.hoisted(() => ({
  write: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./actions", () => ({ setRunEnrichment: write }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
const { EnrichmentSwitch } = await import("./enrichment-switch");
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  write.mockResolvedValue({ ok: true, value: {} });
});
function show(canEdit = true) {
  render(
    <IntlProvider>
      <EnrichmentSwitch org="acme" ws="core" enabled canEdit={canEdit} />
    </IntlProvider>,
  );
}
describe("automatic run names and summaries", () => {
  it("writes an explicit false, then rereads server state", async () => {
    show();
    await userEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith("acme", "core", false);
    });
    expect(refresh).toHaveBeenCalled();
  });
  it("shows the workspace setting read-only to a member", () => {
    show(false);
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(write).not.toHaveBeenCalled();
  });
  it("keeps the saved value and exposes a failed write", async () => {
    write.mockRejectedValue(new Error("offline"));
    show();
    await userEvent.click(screen.getByRole("checkbox"));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(refresh).not.toHaveBeenCalled();
  });
});
