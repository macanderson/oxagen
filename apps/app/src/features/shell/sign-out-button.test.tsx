// @vitest-environment jsdom
// The sign-out button for pages outside the shell (#5151). Only a sign-out the
// server confirmed leaves for the sign-in page. A refused or thrown one stays
// and says the session is still open, as the user menu does.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { SignOutButton } from "./sign-out-button";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/github/steering/result",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: vi.fn() }),
}));

const liveSignOut = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("./session-client", () => ({ liveSignOut }));

function renderButton() {
  return render(
    <IntlProvider>
      <SignOutButton />
    </IntlProvider>,
  );
}

beforeEach(() => {
  nav.replace.mockReset();
  liveSignOut.mockReset();
  liveSignOut.mockResolvedValue(true);
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("SignOutButton", () => {
  it("signs out, then goes to the sign-in page", async () => {
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(liveSignOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login"));
    expect(screen.getByRole("alert")).toHaveTextContent("");
  });

  it("stays and says so when the server refuses the sign-out (negative)", async () => {
    liveSignOut.mockResolvedValueOnce(false);
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Sign-out did not go through, so this session is still open.",
      ),
    );
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("stays and says so when the sign-out call throws (negative)", async () => {
    liveSignOut.mockRejectedValueOnce(new Error("offline"));
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "this session is still open",
      ),
    );
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
