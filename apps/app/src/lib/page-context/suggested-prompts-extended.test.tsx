// @vitest-environment jsdom
/**
 * suggested-prompts-extended.test.tsx — covers the remaining sections of
 * deriveSuggestions (members, developer) and the useSuggestedPrompts hook
 * (requires jsdom + PageContextProvider + usePathname mock).
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import * as React from "react";
import { deriveSuggestions, useSuggestedPrompts } from "./suggested-prompts";
import type { SuggestionCtx } from "./suggested-prompts";
import type { PageEntity, RegisteredFillableForm } from "./types";

// ---------------------------------------------------------------------------
// Mock next/navigation — useSuggestedPrompts calls usePathname
// ---------------------------------------------------------------------------
const mockPathname = { value: "/acme/prod/ask" };
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname.value,
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function ctx(
  pathname: string,
  entity: PageEntity | null = null,
  fillableForm: RegisteredFillableForm | null = null,
): SuggestionCtx {
  return { pathname, entity, fillableForm };
}

// ---------------------------------------------------------------------------
// Members route
// ---------------------------------------------------------------------------
describe("deriveSuggestions — members route", () => {
  const prompts = deriveSuggestions(ctx("/acme/members"));

  it("returns exactly 3 prompts", () => {
    expect(prompts).toHaveLength(3);
  });

  it("prompts are members-specific", () => {
    const texts = prompts.map((p) => p.prompt.toLowerCase()).join(" ");
    expect(texts).toMatch(/member|access|invite/i);
  });
});

// ---------------------------------------------------------------------------
// Developer route
// ---------------------------------------------------------------------------
describe("deriveSuggestions — developer route", () => {
  const prompts = deriveSuggestions(ctx("/acme/developer/mcp"));

  it("returns exactly 3 prompts", () => {
    expect(prompts).toHaveLength(3);
  });

  it("prompts are developer-specific", () => {
    const texts = prompts.map((p) => p.prompt.toLowerCase()).join(" ");
    expect(texts).toMatch(/mcp|api|token|webhook|developer/i);
  });
});

// ---------------------------------------------------------------------------
// Account route without form — entity fills slot, account chips fill remaining
// ---------------------------------------------------------------------------
describe("deriveSuggestions — account route, no form, user entity", () => {
  const entity: PageEntity = { kind: "user", id: "u-1", label: "Mac" };
  const prompts = deriveSuggestions(ctx("/account/security", entity));

  it("returns exactly 3 prompts", () => {
    expect(prompts).toHaveLength(3);
  });

  it("includes account security/preferences chips", () => {
    const texts = prompts.map((p) => p.prompt.toLowerCase()).join(" ");
    expect(texts).toMatch(/preference|security|profile|account/i);
  });
});

// ---------------------------------------------------------------------------
// Organization entity chip
// ---------------------------------------------------------------------------
describe("deriveSuggestions — organization entity", () => {
  const entity: PageEntity = {
    kind: "organization",
    id: "org-1",
    label: "Acme",
  };
  const prompts = deriveSuggestions(ctx("/acme/prod", entity));

  it("returns org overview chip for organization entity", () => {
    const texts = prompts.map((p) => p.prompt.toLowerCase()).join(" ");
    expect(texts).toMatch(/organization|overview/i);
  });
});

// ---------------------------------------------------------------------------
// Generic entity (unknown kind)
// ---------------------------------------------------------------------------
describe("deriveSuggestions — unknown entity kind", () => {
  const entity: PageEntity = { kind: "pipeline", id: "p-1", label: "ETL Run" };
  const prompts = deriveSuggestions(ctx("/acme/prod", entity));

  it("uses the generic About This <kind> chip", () => {
    const entityChip = prompts.find(
      (p) => p.label.includes("pipeline") || p.label.includes("Pipeline"),
    );
    expect(entityChip).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Profile entity kind
// ---------------------------------------------------------------------------
describe("deriveSuggestions — profile entity kind", () => {
  const entity: PageEntity = { kind: "profile", id: "p-1", label: "Mac" };
  const prompts = deriveSuggestions(ctx("/account/profile", entity));

  it("includes profile suggestions chip", () => {
    const texts = prompts.map((p) => p.prompt.toLowerCase()).join(" ");
    expect(texts).toMatch(/profile/i);
  });
});

// ---------------------------------------------------------------------------
// useSuggestedPrompts hook — requires jsdom + PageContextProvider
// ---------------------------------------------------------------------------
import { PageContextProvider } from "./index";

describe("useSuggestedPrompts hook", () => {
  function wrapper({ children }: { children: React.ReactNode }) {
    return <PageContextProvider>{children}</PageContextProvider>;
  }

  it("returns exactly 3 prompts", () => {
    mockPathname.value = "/acme/prod/ask";
    const { result } = renderHook(() => useSuggestedPrompts(), { wrapper });
    expect(result.current).toHaveLength(3);
  });

  it("returns prompts with non-empty label and prompt", () => {
    mockPathname.value = "/acme/prod/settings/general";
    const { result } = renderHook(() => useSuggestedPrompts(), { wrapper });
    for (const p of result.current) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.prompt.length).toBeGreaterThan(0);
    }
  });

  it("adapts suggestions when pathname changes (billing route)", () => {
    mockPathname.value = "/acme/billing";
    const { result } = renderHook(() => useSuggestedPrompts(), { wrapper });
    const texts = result.current.map((p) => p.prompt.toLowerCase()).join(" ");
    expect(texts).toMatch(/usage|cost|plan|billing/i);
  });
});
