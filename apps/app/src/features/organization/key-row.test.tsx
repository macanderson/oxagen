// @vitest-environment jsdom
// The two clocked cells of an API keys row, Expires and the controls, drawn
// side by side as the table draws them: each runs its own clock from the same
// captured instant, so a page left open past an expiry cannot show "live" over
// a row with no Rotate.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKey } from "@/data/contracts/org";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { apiKey } from "./organization.builders";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./api-key-actions", () => ({
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
}));

const { KeyActionsCell, KeyExpiryCell } = await import("./key-row");

const HERE = routes.apiKeys("acme", { workspace: "core-platform" });
const NOW = Date.parse("2026-09-16T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function renderRow(key: ApiKey, now = NOW, archived = false) {
  render(
    <IntlProvider>
      <table>
        <tbody>
          <tr>
            <td>
              <KeyExpiryCell apiKey={key} now={now} />
            </td>
            <td>
              <KeyActionsCell
                apiKey={key}
                org="acme"
                ws="core-platform"
                archived={archived}
                now={now}
                listedIds={[key.id]}
                after={HERE}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </IntlProvider>,
  );
  const row = screen.getByRole("row");
  return {
    row,
    status: () =>
      row.querySelector("[data-status]")?.getAttribute("data-status"),
    buttons: () =>
      within(row)
        .queryAllByRole("button")
        .map((b) => b.textContent),
  };
}

describe("a row's state and its controls come from one clock", () => {
  it("reads live with Rotate and Revoke for a key with no expiry", async () => {
    const view = renderRow(apiKey());
    expect(view.status()).toBe("live");
    expect(view.buttons()).toEqual(["Rotate", "Revoke"]);
    await expectNoAxe(document.body);
  });

  it("words the Expires badge as the design does: active, expires in N days, never used", () => {
    const soon = apiKey({
      id: "aky_soon000000000000000000",
      expiresAt: new Date(NOW + 21 * 86_400_000 - 1000).toISOString(),
    });
    renderRow(soon);
    expect(screen.getByText("expires in 21 days")).toHaveAttribute(
      "data-status",
      "expiring",
    );
    cleanup();
    renderRow(apiKey({ lastUsedAt: null }));
    expect(screen.getByText("never used")).toHaveAttribute(
      "data-status",
      "never-used",
    );
    cleanup();
    renderRow(apiKey());
    expect(screen.getByText("active")).toHaveAttribute("data-status", "live");
    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("reads expired with Revoke alone for a key whose expiry has passed", () => {
    const view = renderRow(apiKey({ expiresAt: "2026-09-15T12:00:00.000Z" }));
    expect(view.status()).toBe("expired");
    expect(view.buttons()).toEqual(["Revoke"]);
  });

  it("reads revoked with no controls at all", () => {
    const view = renderRow(apiKey({ revokedAt: "2026-09-10T08:00:00.000Z" }));
    expect(view.status()).toBe("revoked");
    expect(view.buttons()).toEqual([]);
  });

  it("offers Revoke alone on a live key in an archived workspace (negative)", () => {
    // A rotation mints fresh secret material for a workspace meant to be
    // inert, so `rotate_api_key` refuses one and the control is withheld.
    // Revoke stays — it is what the archived workspace's keys are listed for,
    // and the action that helps with a compromised key. The key still reads
    // live, because it is: archival revokes nothing (#3123).
    const view = renderRow(apiKey(), NOW, true);
    expect(view.status()).toBe("live");
    expect(view.buttons()).toEqual(["Revoke"]);
  });

  it("reads live with Revoke alone for a key a service owns", () => {
    const view = renderRow(apiKey({ rotatable: false }));
    expect(view.status()).toBe("live");
    expect(view.buttons()).toEqual(["Revoke"]);
  });

  it("turns the status and the controls over together when the expiry passes while the page is open", async () => {
    // The page clock is captured once, server-side. Both halves of the row read
    // the same running clock, so the row cannot offer Rotate on an expired key.
    // Inside the last thirty days a live key reads "expires in N days".
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    const view = renderRow(
      apiKey({ expiresAt: new Date(NOW + 20_000).toISOString() }),
    );
    expect(view.status()).toBe("expiring");
    expect(view.buttons()).toEqual(["Rotate", "Revoke"]);

    await act(async () => {
      vi.setSystemTime(NOW + 60_000);
      await vi.advanceTimersByTimeAsync(31_000);
    });

    expect(view.status()).toBe("expired");
    expect(view.buttons()).toEqual(["Revoke"]);
  });

  it("leaves a key with no expiry live however long the page is open (negative)", async () => {
    // Nothing to cross, so nothing this row does can change its own answer.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    const view = renderRow(apiKey());
    await act(async () => {
      vi.setSystemTime(NOW + 86_400_000);
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(view.status()).toBe("live");
    expect(view.buttons()).toEqual(["Rotate", "Revoke"]);
  });
});
