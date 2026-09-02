// @vitest-environment jsdom
/**
 * onboarding-recommendation.test.tsx — proves the Storybook story's visible
 * success state after the schema-service fixtures fix.
 *
 * Before the fix, the component's mount-time recommend() call fetched
 * /api/schema/recommend — a 404 in Storybook (no API backend) — and rendered
 * its error box. Now, under Storybook (the __OXAGEN_STORYBOOK__ flag that
 * .storybook/preview.ts sets), recommend() returns in-memory fixtures and the
 * component renders the recommendation cards. This test mounts the real
 * component and asserts that visible success state, and that the 404 error box
 * is gone.
 */

import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OnboardingRecommendation } from "./onboarding-recommendation";

type StorybookGlobal = { __OXAGEN_STORYBOOK__?: boolean };
function setStorybook(on: boolean): void {
  if (on) (globalThis as StorybookGlobal).__OXAGEN_STORYBOOK__ = true;
  else delete (globalThis as StorybookGlobal).__OXAGEN_STORYBOOK__;
}

const SLUGS = { orgSlug: "acme", workspaceSlug: "main" };
const noopApply = async (): Promise<void> => {};
const noopDiscard = (): void => {};

afterEach(() => {
  cleanup();
  setStorybook(false);
});

describe("OnboardingRecommendation story render (under Storybook)", () => {
  beforeEach(() => setStorybook(true));

  it("renders the fixture recommendation cards, not the 404 error box", async () => {
    render(
      <OnboardingRecommendation
        slugs={SLUGS}
        onApply={noopApply}
        onDiscard={noopDiscard}
      />,
    );

    // Success state appears once the fixture data resolves.
    expect(await screen.findByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText(/Contact/)).toBeInTheDocument();
    expect(screen.getByText(/Deal/)).toBeInTheDocument();
    expect(
      screen.getByText(/Based on 180 sampled nodes\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();

    // The reported symptom — a "Request failed (404)" / failure error box —
    // must NOT be present.
    expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Failed to get recommendations/),
    ).not.toBeInTheDocument();
  });
});
