// @vitest-environment jsdom
/**
 * oauth-buttons.test.tsx — render + interaction tests for OAuthButtons.
 *
 * Covers:
 *   - Renders Google and GitHub buttons
 *   - Clicking Google calls authClient.signIn.social with { provider: "google", callbackURL }
 *   - Clicking GitHub calls authClient.signIn.social with { provider: "github", callbackURL }
 *   - Default callbackURL is "/"
 *   - Custom callbackURL is forwarded
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OAuthButtons } from "./oauth-buttons";

afterEach(cleanup);

const { signInSocialMock } = vi.hoisted(() => ({
  signInSocialMock: vi.fn(),
}));

vi.mock("@oxagen/auth/client", () => ({
  authClient: {
    signIn: { social: signInSocialMock },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  signInSocialMock.mockResolvedValue({});
});

describe("OAuthButtons", () => {
  it("renders 'Continue with Google' button", () => {
    render(<OAuthButtons />);
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeInTheDocument();
  });

  it("renders 'Continue with GitHub' button", () => {
    render(<OAuthButtons />);
    expect(
      screen.getByRole("button", { name: /continue with github/i }),
    ).toBeInTheDocument();
  });

  it("clicking Google calls signIn.social with provider='google' and default callbackURL='/'", async () => {
    render(<OAuthButtons />);
    await userEvent.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );
    expect(signInSocialMock).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/",
    });
  });

  it("clicking GitHub calls signIn.social with provider='github' and default callbackURL='/'", async () => {
    render(<OAuthButtons />);
    await userEvent.click(
      screen.getByRole("button", { name: /continue with github/i }),
    );
    expect(signInSocialMock).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "/",
    });
  });

  it("forwards a custom callbackURL", async () => {
    render(<OAuthButtons callbackURL="/dashboard" />);
    await userEvent.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );
    expect(signInSocialMock).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/dashboard",
    });
  });
});
