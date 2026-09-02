// @vitest-environment jsdom
/**
 * datasets-section.test.tsx — render coverage for the async DatasetsSection
 * Server Component.
 *
 * Awaited directly (it's an async function returning JSX). DatasetsClient and
 * the shared ErrorState are stubbed so this file covers only the section's own
 * failure-vs-empty branching: a fetch failure renders ErrorState (never a bare
 * client masquerading a failure as empty); a successful read renders the client.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const { mockInvoke, mockRunInTenantScope } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/_shared/components", () => ({
  ErrorState: ({ title }: { title?: string }) => (
    <div data-testid="error-state" data-title={title ?? ""} />
  ),
}));

vi.mock("./datasets-client", () => ({
  DatasetsClient: ({ datasets }: { datasets: unknown[] }) => (
    <div data-testid="datasets-client" data-count={datasets.length} />
  ),
}));

import { DatasetsSection } from "./datasets-section";

afterEach(cleanup);
beforeEach(() => {
  mockInvoke.mockReset();
  mockRunInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
});

const BASE = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "main",
};

describe("DatasetsSection", () => {
  it("renders the client with datasets on success", async () => {
    mockInvoke.mockResolvedValue({
      datasets: [{ datasetId: "d1" }, { datasetId: "d2" }],
    });
    render(await DatasetsSection(BASE));
    expect(screen.getByTestId("datasets-client")).toHaveAttribute(
      "data-count",
      "2",
    );
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders the empty client — not an error — when there are genuinely no datasets", async () => {
    mockInvoke.mockResolvedValue({ datasets: [] });
    render(await DatasetsSection(BASE));
    expect(screen.getByTestId("datasets-client")).toHaveAttribute(
      "data-count",
      "0",
    );
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders ErrorState — not the client — when the fetch fails", async () => {
    mockInvoke.mockRejectedValue(new Error("db down"));
    render(await DatasetsSection(BASE));
    expect(screen.getByTestId("error-state")).toHaveAttribute(
      "data-title",
      "Couldn't load datasets",
    );
    expect(screen.queryByTestId("datasets-client")).toBeNull();
  });
});
