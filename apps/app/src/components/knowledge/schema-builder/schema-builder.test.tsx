// @vitest-environment jsdom
/**
 * schema-builder.test.tsx — the no-schema empty state.
 *
 * Regression guard for the ontology page's ghost cards: the AI recommendation
 * flow (OnboardingRecommendation) fetches + renders loading skeletons on mount,
 * so it must NOT be auto-mounted under the "No schemas defined" empty state —
 * it is gated behind an explicit primary CTA. Heavy children and the schema
 * service are mocked so this suite stays focused on the empty-state wiring.
 */

import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const { fetchRegistryMock } = vi.hoisted(() => ({
  fetchRegistryMock: vi.fn(),
}));

vi.mock("./schema-service", () => ({
  fetchRegistry: fetchRegistryMock,
  toggleSchema: vi.fn(),
  upsertLabel: vi.fn(),
  upsertRelationship: vi.fn(),
}));

vi.mock("./reconcile-actions", () => ({
  schemaReconcileDispatchAction: vi.fn(),
}));

// Marker for the AI recommendation panel — its own render/fetch behavior is
// covered by onboarding-recommendation.test.tsx.
vi.mock("./onboarding-recommendation", () => ({
  OnboardingRecommendation: () => <div data-testid="onboarding-rec" />,
}));

// The rest of the builder's children are irrelevant to the empty state.
vi.mock("./schema-list", () => ({ SchemaList: () => <div data-testid="schema-list" /> }));
vi.mock("./label-editor", () => ({ LabelEditor: () => null }));
vi.mock("./relationship-editor", () => ({ RelationshipEditor: () => null }));
vi.mock("./version-history", () => ({ VersionHistory: () => null }));
vi.mock("./pin-change-dialog", () => ({ PinChangeDialog: () => null }));
vi.mock("./export-button", () => ({ ExportButton: () => null }));
vi.mock("./schema-assistant-drawer", () => ({ SchemaAssistantDrawer: () => null }));

import { SchemaBuilder } from "./schema-builder";

const SLUGS = { orgSlug: "acme", workspaceSlug: "main" };

const EMPTY_REGISTRY = {
  registryId: "reg1",
  pinnedVersionId: null,
  draftVersionId: null,
  enforcementMode: "off" as const,
  conformanceFloor: 0,
  schemas: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SchemaBuilder — no-schema empty state", () => {
  it("does not auto-mount the recommendation panel (no ghost skeleton cards)", async () => {
    fetchRegistryMock.mockResolvedValue(EMPTY_REGISTRY);
    render(<SchemaBuilder slugs={SLUGS} isAdmin />);

    expect(await screen.findByText("No schemas defined")).toBeInTheDocument();
    // The mount-time-fetching recommendation panel is gated, not rendered.
    expect(screen.queryByTestId("onboarding-rec")).toBeNull();
    // A primary CTA lives inside the empty state.
    expect(
      screen.getByRole("button", { name: /use ai recommendations/i }),
    ).toBeInTheDocument();
  });

  it("reveals the recommendation panel only after the CTA is clicked", async () => {
    fetchRegistryMock.mockResolvedValue(EMPTY_REGISTRY);
    render(<SchemaBuilder slugs={SLUGS} isAdmin />);

    const cta = await screen.findByRole("button", {
      name: /use ai recommendations/i,
    });
    fireEvent.click(cta);

    expect(screen.getByTestId("onboarding-rec")).toBeInTheDocument();
    // The CTA collapses once the panel is open.
    expect(
      screen.queryByRole("button", { name: /use ai recommendations/i }),
    ).toBeNull();
  });
});
