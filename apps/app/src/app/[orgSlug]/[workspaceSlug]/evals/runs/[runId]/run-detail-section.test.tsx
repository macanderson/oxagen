// @vitest-environment jsdom
/**
 * run-detail-section.test.tsx — render coverage for the async RunDetailSection
 * Server Component.
 *
 * Awaited directly (it's an async function returning JSX). RunDetailClient and
 * the shared ErrorState are stubbed so this file covers only the section's own
 * failure branching: a failed read (including "run not found") renders
 * ErrorState rather than a bare client. A single-entity detail has no "empty"
 * state — a successful read always renders the client.
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

vi.mock("./run-detail-client", () => ({
  RunDetailClient: ({ run }: { run: { runId?: string } | null }) => (
    <div data-testid="run-detail-client" data-run={run?.runId ?? ""} />
  ),
}));

import { RunDetailSection } from "./run-detail-section";

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
  runPublicId: "evr_abc",
};

describe("RunDetailSection", () => {
  it("renders the client with the run on success", async () => {
    mockInvoke.mockResolvedValue({ run: { runId: "evr_abc" }, results: [] });
    render(await RunDetailSection(BASE));
    expect(screen.getByTestId("run-detail-client")).toHaveAttribute(
      "data-run",
      "evr_abc",
    );
    expect(screen.queryByTestId("error-state")).toBeNull();
  });

  it("renders ErrorState — not the client — when the read fails (including not-found)", async () => {
    mockInvoke.mockRejectedValue(new Error("run not found"));
    render(await RunDetailSection(BASE));
    expect(screen.getByTestId("error-state")).toHaveAttribute(
      "data-title",
      "Couldn't load this run",
    );
    expect(screen.queryByTestId("run-detail-client")).toBeNull();
  });
});
