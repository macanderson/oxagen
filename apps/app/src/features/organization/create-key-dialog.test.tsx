// @vitest-environment jsdom
// The write surface of the API keys page: the dialog that mints a key, the one
// showing of its secret, and the two controls on a live key's row.
//
// The case the design turns on is "a re-render from server data": the secret
// lives in this island's state and nowhere else, so when the roster comes back
// carrying the new key the showing ends. Nothing the server sends can put a
// secret on screen, and nothing keeps one there once the key is listed.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, createApiKey, revokeApiKey, rotateApiKey } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./api-key-actions", () => ({
  createApiKey,
  revokeApiKey,
  rotateApiKey,
}));

const { CreateKeyDialog, KeyRowActions } = await import("./create-key-dialog");

const HERE = routes.apiKeys("acme", { workspace: "core-platform" });
const WS = "core-platform";
const KEY = "aky_7k2m9q4x8r1t5v3w6y0z2a";
const SECRET = "ox_3fa85f64571b4c62a0f5e8c9d1b2a3f4";
const minted = {
  id: KEY,
  name: "CI runner",
  prefix: "ox_3fa85f6457",
  secret: SECRET,
  expiresAt: null,
};

function createDialog(listedIds: readonly string[] = []) {
  return (
    <IntlProvider>
      <CreateKeyDialog org="acme" ws={WS} listedIds={listedIds} after={HERE} />
    </IntlProvider>
  );
}

const NOW = Date.parse("2026-09-16T12:00:00.000Z");

function renderRow(
  listedIds: readonly string[] = [KEY],
  rotatable = true,
  lifetime: { expiresAt?: string | null; revokedAt?: string | null } = {},
) {
  return render(
    <IntlProvider>
      <KeyRowActions
        org="acme"
        ws={WS}
        keyId={KEY}
        keyName="CI runner"
        expiresAt={lifetime.expiresAt ?? null}
        revokedAt={lifetime.revokedAt ?? null}
        rotatable={rotatable}
        now={NOW}
        listedIds={listedIds}
        after={HERE}
      />
    </IntlProvider>,
  );
}

async function openDialog(open: string, testId: string) {
  await userEvent.click(screen.getByRole("button", { name: open }));
  return screen.getByTestId(testId);
}

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  createApiKey.mockReset();
  revokeApiKey.mockReset();
  rotateApiKey.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("create", () => {
  it("mints the key under the name and day given, and shows the secret once", async () => {
    createApiKey.mockResolvedValue({ ok: true, value: minted });
    render(createDialog());
    const dialog = await openDialog("Create a key", "create-api-key");
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI runner");
    fireEvent.change(
      within(dialog).getByLabelText(
        "Expires at the end of this day, UTC (optional)",
      ),
      { target: { value: "2027-03-01" } },
    );
    // The control carries no timezone, so the note says what will be stored.
    expect(dialog).toHaveTextContent(
      "The key stops working at 2027-03-01T23:59:59.999Z.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create it" }),
    );
    expect(createApiKey).toHaveBeenCalledWith(
      "acme",
      WS,
      "CI runner",
      "2027-03-01",
    );
    const panel = await screen.findByTestId("api-key-secret");
    expect(within(panel).getByTestId("api-key-secret-value")).toHaveTextContent(
      SECRET,
    );
    expect(panel).toHaveTextContent("CI runner · begins ox_3fa85f6457");
    expect(panel).toHaveTextContent("This is the only time Oxagen shows it.");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("does not keep the secret through a re-render from server data (negative)", async () => {
    createApiKey.mockResolvedValue({ ok: true, value: minted });
    const view = render(createDialog([]));
    const dialog = await openDialog("Create a key", "create-api-key");
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI runner");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create it" }),
    );
    expect(await screen.findByTestId("api-key-secret")).toBeInTheDocument();

    // The roster reloaded and now lists the key: the showing is over.
    view.rerender(createDialog([KEY]));
    await waitFor(() => {
      expect(screen.queryByTestId("api-key-secret")).toBeNull();
    });
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.queryByTestId("create-api-key")).toBeNull();
  });

  it("says the day is read in UTC before one is picked", async () => {
    render(createDialog());
    const dialog = await openDialog("Create a key", "create-api-key");
    expect(dialog).toHaveTextContent(
      "The day is read in UTC, not your local time.",
    );
    expect(
      within(dialog).getByLabelText(
        "Expires at the end of this day, UTC (optional)",
      ),
    ).toHaveAttribute("aria-describedby", "api-key-expires-note");
  });

  it("drops the secret when the roster first lists the key, so a later roster cannot bring it back (negative)", async () => {
    // Switching the workspace picker re-renders this island against another
    // workspace's roster, which does not list the key. A secret still held in
    // state would be shown a second time by that render.
    createApiKey.mockResolvedValue({ ok: true, value: minted });
    const view = render(createDialog([]));
    const dialog = await openDialog("Create a key", "create-api-key");
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI runner");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create it" }),
    );
    expect(await screen.findByTestId("api-key-secret")).toBeInTheDocument();

    view.rerender(createDialog([KEY]));
    await waitFor(() => {
      expect(screen.queryByTestId("api-key-secret")).toBeNull();
    });

    view.rerender(createDialog([]));
    view.rerender(createDialog(["aky_0a1b2c3d4e5f6g7h8j9k0m"]));
    expect(screen.queryByTestId("api-key-secret")).toBeNull();
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.queryByTestId("create-api-key")).toBeNull();
    expect(document.body).not.toHaveTextContent(SECRET);
  });

  it("refuses to be dismissed while the write is in flight, so the island cannot unmount before the secret lands (negative)", async () => {
    // Dismissing and then navigating — the workspace picker, the People tab,
    // the sidebar — unmounts this island, and the secret comes back once. The
    // dialog is modal over a scrim, so holding it holds that navigation too.
    let answer: (result: unknown) => void = () => undefined;
    createApiKey.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    render(createDialog());
    const dialog = await openDialog("Create a key", "create-api-key");
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI runner");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create it" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("create-api-key")).toBeInTheDocument();

    answer({ ok: true, value: minted });
    const panel = await screen.findByTestId("api-key-secret");
    expect(within(panel).getByTestId("api-key-secret-value")).toHaveTextContent(
      SECRET,
    );
    // Dismissable again once nothing is in flight.
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("api-key-secret")).toBeNull();
    });
  });

  it("reloads the page when the person closes the secret, and shows it no more", async () => {
    createApiKey.mockResolvedValue({ ok: true, value: minted });
    render(createDialog());
    const dialog = await openDialog("Create a key", "create-api-key");
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI runner");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create it" }),
    );
    await screen.findByTestId("api-key-secret");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(router.replace).toHaveBeenCalledWith(HERE);
    expect(router.refresh).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByTestId("api-key-secret")).toBeNull();
    });
  });

  it.each([
    [
      { ok: false, reason: "invalid", code: "name_required", field: "name" },
      "Give the key a name so the roster can tell it apart.",
    ],
    [
      {
        ok: false,
        reason: "invalid",
        code: "expiry_not_a_day",
        field: "expiresAt",
      },
      "That expiry is not a date. Pick a day, or leave it empty for a key that does not expire.",
    ],
    [
      {
        ok: false,
        reason: "invalid",
        code: "expiry_in_the_past",
        field: "expiresAt",
      },
      "That day is already over. Pick a later one, or leave it empty for a key that does not expire.",
    ],
    [
      { ok: false, reason: "denied", code: "authz_denied" },
      "Your organization role does not allow this. Nothing was changed.",
    ],
    [
      { ok: false, reason: "not_found", code: "api_key_not_found" },
      "This key is no longer here, or it was already revoked.",
    ],
    [
      { ok: false, reason: "not_found", code: "not_found" },
      "The change was refused: not_found. Nothing was changed.",
    ],
    [
      { ok: false, reason: "invalid", code: "invalid_input", field: "name" },
      "The request was refused as invalid. Nothing was changed.",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "acr_1" },
      "The change is waiting for approval, request acr_1.",
    ],
    [
      { ok: false, reason: "unavailable", code: "kernel_failure" },
      "The change could not be made: kernel_failure. Nothing was changed.",
    ],
  ])(
    "names a refusal, shows no secret and reloads nothing (negative)",
    async (result, text) => {
      createApiKey.mockResolvedValue(result);
      render(createDialog());
      const dialog = await openDialog("Create a key", "create-api-key");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Create it" }),
      );
      expect(
        await screen.findByTestId("create-api-key-failure"),
      ).toHaveTextContent(text);
      expect(screen.queryByTestId("api-key-secret")).toBeNull();
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("forgets a refusal when the dialog is closed, and reloads nothing (negative)", async () => {
    createApiKey.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    render(createDialog());
    const dialog = await openDialog("Create a key", "create-api-key");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create it" }),
    );
    await screen.findByTestId("create-api-key-failure");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(router.replace).not.toHaveBeenCalled();
    await openDialog("Create a key", "create-api-key");
    expect(screen.queryByTestId("create-api-key-failure")).toBeNull();
  });

  it("names a write that threw before it answered (negative)", async () => {
    createApiKey.mockRejectedValue(new Error("socket hang up"));
    render(createDialog());
    const dialog = await openDialog("Create a key", "create-api-key");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create it" }),
    );
    expect(
      await screen.findByTestId("create-api-key-failure"),
    ).toHaveTextContent(
      "The change could not be made: action_failed. Nothing was changed.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("rotate", () => {
  it("replaces the key and shows the replacement's secret once", async () => {
    rotateApiKey.mockResolvedValue({
      ok: true,
      value: { ...minted, id: "aky_0a1b2c3d4e5f6g7h8j9k0m" },
    });
    renderRow();
    const dialog = await openDialog("Rotate", "rotate-api-key");
    expect(dialog).toHaveTextContent("Rotate CI runner");
    expect(dialog).toHaveTextContent(
      "Requests presenting the old key are refused from that moment",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Rotate it" }),
    );
    expect(rotateApiKey).toHaveBeenCalledWith("acme", WS, KEY);
    expect(
      within(await screen.findByTestId("api-key-secret")).getByTestId(
        "api-key-secret-value",
      ),
    ).toHaveTextContent(SECRET);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a refused rotation and shows no secret (negative)", async () => {
    rotateApiKey.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    renderRow();
    const dialog = await openDialog("Rotate", "rotate-api-key");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Rotate it" }),
    );
    expect(
      await screen.findByTestId("rotate-api-key-failure"),
    ).toHaveTextContent(
      "Your organization role does not allow this. Nothing was changed.",
    );
    expect(screen.queryByTestId("api-key-secret")).toBeNull();
  });
});

describe("a key that may not be rotated", () => {
  it("offers Revoke and no Rotate when the read says a service owns the key (negative)", () => {
    renderRow([KEY], false);
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(rotateApiKey).not.toHaveBeenCalled();
  });

  it("offers Revoke and no Rotate when the key expired before the page was rendered (negative)", () => {
    renderRow([KEY], true, { expiresAt: "2026-09-15T12:00:00.000Z" });
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
  });

  it("takes Rotate off a row whose expiry passes while the page is open (negative)", async () => {
    // The page clock is captured once, server-side. Rotation copies the expiry
    // that ended the key onto the replacement, so the control must not outlive
    // the key. The handler refuses regardless; this only narrows the window.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(NOW);
      renderRow([KEY], true, {
        expiresAt: new Date(NOW + 20_000).toISOString(),
      });
      expect(
        screen.getByRole("button", { name: "Rotate" }),
      ).toBeInTheDocument();
      await act(async () => {
        vi.setSystemTime(NOW + 60_000);
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Revoke" }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the handler's refusal when a key expires between the render and the click (negative)", async () => {
    rotateApiKey.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "api_key_expired",
    });
    renderRow();
    const dialog = await openDialog("Rotate", "rotate-api-key");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Rotate it" }),
    );
    expect(
      await screen.findByTestId("rotate-api-key-failure"),
    ).toHaveTextContent(
      "This key expired while the page was open. Rotating it would copy the expiry that ended it onto the replacement, so nothing was changed. Create a new key instead.",
    );
    expect(screen.queryByTestId("api-key-secret")).toBeNull();
  });
});

describe("revoke", () => {
  it("ends the key and reloads the page, showing no secret", async () => {
    revokeApiKey.mockResolvedValue({ ok: true, value: { keyId: KEY } });
    renderRow();
    const dialog = await openDialog("Revoke", "revoke-api-key");
    expect(dialog).toHaveTextContent("Revoke CI runner");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke" }),
    );
    expect(revokeApiKey).toHaveBeenCalledWith("acme", WS, KEY);
    expect(router.replace).toHaveBeenCalledWith(HERE);
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("api-key-secret")).toBeNull();
  });

  it("names a key that was already revoked and reloads nothing (negative)", async () => {
    revokeApiKey.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "api_key_not_found",
    });
    renderRow();
    const dialog = await openDialog("Revoke", "revoke-api-key");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke" }),
    );
    expect(
      await screen.findByTestId("revoke-api-key-failure"),
    ).toHaveTextContent(
      "This key is no longer here, or it was already revoked.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});
