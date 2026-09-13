// @vitest-environment jsdom
/**
 * github-connection-wizard-step1.test.tsx — tests for GitHubInstallGate.
 *
 * The gate is shown when the workspace GitHub App is not yet installed.
 * It directs the user to Workspace Settings → GitHub instead of running
 * OAuth here (install now lives in settings; 1 workspace = 1 app install).
 *
 * Covers:
 *   - Renders a settings link pointing at /{org}/{ws}/settings/github.
 *   - Calls onClose when the Cancel button is clicked.
 */

/// <reference types="@testing-library/jest-dom" />

import * as React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { GitHubInstallGate } from "./github-connection-wizard-step1";

const ORG = "acme";
const WS = "main";

afterEach(cleanup);

describe("GitHubInstallGate", () => {
  it("renders the settings link with the correct workspace GitHub settings href", () => {
    render(
      <GitHubInstallGate orgSlug={ORG} workspaceSlug={WS} onClose={vi.fn()} />,
    );

    expect(screen.getByTestId("github-install-gate")).toBeInTheDocument();

    const link = screen.getByTestId("github-gate-settings-link");
    expect(link).toBeInTheDocument();
    // href must point at the workspace GitHub settings page, not the OAuth flow.
    expect(link).toHaveAttribute("href", `/${ORG}/${WS}/settings/github`);
    expect(link).toHaveTextContent("Open GitHub settings");
  });

  it("calls onClose when the Cancel button is clicked", () => {
    const onClose = vi.fn();
    render(
      <GitHubInstallGate orgSlug={ORG} workspaceSlug={WS} onClose={onClose} />,
    );

    fireEvent.click(screen.getByTestId("github-gate-cancel-btn"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
