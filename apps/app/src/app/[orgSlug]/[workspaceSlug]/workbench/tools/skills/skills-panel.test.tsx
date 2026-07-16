// @vitest-environment jsdom
/**
 * skills-panel.test.tsx — unit tests for SkillsPanel and SkillsPanelSkeleton.
 *
 * Covers:
 *   (a) Renders skill name + slug for each row
 *   (b) Source badge shows "Built-in" for source="builtin"
 *   (c) Source badge shows "Custom" for source="tenant"
 *   (d) Shows "—" for null dates (updatedAt / lastUsedAt)
 *   (e) Shows formatted date when date is provided
 *   (f) Filter input narrows visible rows — matching slug/name/description
 *   (g) Empty state when skills=[]
 *   (h) Empty state when filter matches nothing
 *   (i) Skill count label matches visible results
 *   (j) Detail link has the correct href (slug-encoded)
 *   (k) SkillsPanelSkeleton renders without crashing
 */

import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { SkillRow } from "./skills-panel";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

// The embedded NewSkillDialog uses next/navigation + toast; the panel tests
// never open it, so shallow mocks are enough.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant: _v,
    className: _c,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
    "data-testid"?: string;
  }) => <span data-testid={testId}>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
    "data-testid": testId,
    render: renderProp,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
    "data-testid"?: string;
    // The coss-ui Button "render" prop is used to swap the root element (e.g.
    // render a Link instead of a button). For test purposes we just render an
    // anchor with the props we care about when the render element is a Link.
    render?: { props?: { href?: string } };
  }) => {
    if (renderProp?.props?.href !== undefined) {
      return (
        <a
          href={renderProp.props.href}
          aria-label={ariaLabel}
          data-testid={testId}
        >
          {children}
        </a>
      );
    }
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
      >
        {children}
      </button>
    );
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    placeholder,
    "aria-label": ariaLabel,
    "data-testid": testId,
    className: _c,
    ...rest
  }: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    "aria-label"?: string;
    "data-testid"?: string;
    className?: string;
    [key: string]: unknown;
  }) => (
    <input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      aria-label={ariaLabel}
      data-testid={testId}
      {...(rest as object)}
    />
  ),
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className: _c }: { className?: string }) => (
    <div data-testid="skeleton" />
  ),
}));

vi.mock(
  "lucide-react",
  () =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : () => <svg aria-hidden="true" data-icon={String(prop)} />,
      has: (_t, prop) => prop !== "then",
    }),
);

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { SkillsPanel, SkillsPanelSkeleton } from "./skills-panel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "skill-1",
    slug: "summarize-text",
    name: "Summarize Text",
    description: "Condenses long documents into summaries.",
    source: "builtin",
    installedFromSlug: null,
    activeVersion: "1.2.3",
    updatedAt: "2025-01-15T00:00:00Z",
    lastUsedAt: "2025-03-01T00:00:00Z",
    usageCount: 42,
    ...overrides,
  };
}

const DEFAULT_PROPS = {
  orgSlug: "acme",
  workspaceSlug: "main",
  canManage: true,
  createAction: vi.fn(async () => ({ ok: true as const, slug: "new-skill" })),
  draftAction: vi.fn(async () => ({
    ok: false as const,
    error: "not wired in tests",
  })),
} satisfies Partial<React.ComponentProps<typeof SkillsPanel>>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Renders skill name + slug for each row
  it("renders skill name and slug for each skill", () => {
    const skills = [
      makeSkill({ id: "1", slug: "skill-a", name: "Skill A" }),
      makeSkill({ id: "2", slug: "skill-b", name: "Skill B" }),
    ];
    render(<SkillsPanel {...DEFAULT_PROPS} skills={skills} />);

    expect(screen.getByText("Skill A")).toBeInTheDocument();
    expect(screen.getByText("skill-a")).toBeInTheDocument();
    expect(screen.getByText("Skill B")).toBeInTheDocument();
    expect(screen.getByText("skill-b")).toBeInTheDocument();
  });

  // (b) Source badge shows "Built-in"
  it("shows 'Built-in' badge for source=builtin", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ source: "builtin" })]}
      />,
    );
    expect(screen.getByText("Built-in")).toBeInTheDocument();
  });

  // (c) Source badge shows "Custom"
  it("shows 'Custom' badge for source=tenant", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ source: "tenant" })]}
      />,
    );
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  // (d) Shows "—" for null dates
  it("shows em-dash for null updatedAt and lastUsedAt", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ updatedAt: null, lastUsedAt: null })]}
      />,
    );
    // Two em-dashes should appear (one per null date column)
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  // (e) Shows formatted date when date is provided
  it("renders a formatted date when updatedAt is set", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ updatedAt: "2025-01-15T00:00:00Z" })]}
      />,
    );
    // The formatted date should contain "2025" at minimum
    expect(screen.getAllByText(/2025/).length).toBeGreaterThan(0);
  });

  // (f) Filter input narrows visible rows
  it("filter input narrows visible rows by name", () => {
    const skills = [
      makeSkill({ id: "1", slug: "summarize-text", name: "Summarize Text" }),
      makeSkill({ id: "2", slug: "translate-text", name: "Translate Text" }),
    ];
    render(<SkillsPanel {...DEFAULT_PROPS} skills={skills} />);

    const input = screen.getByTestId("skills-search-input");
    fireEvent.change(input, { target: { value: "Summarize" } });

    expect(screen.getByText("Summarize Text")).toBeInTheDocument();
    expect(screen.queryByText("Translate Text")).not.toBeInTheDocument();
  });

  // Filter by slug
  it("filter input narrows visible rows by slug", () => {
    const skills = [
      makeSkill({ id: "1", slug: "summarize-text", name: "Summarize Text" }),
      makeSkill({ id: "2", slug: "translate-text", name: "Translate Text" }),
    ];
    render(<SkillsPanel {...DEFAULT_PROPS} skills={skills} />);

    const input = screen.getByTestId("skills-search-input");
    fireEvent.change(input, { target: { value: "translate" } });

    expect(screen.queryByText("Summarize Text")).not.toBeInTheDocument();
    expect(screen.getByText("Translate Text")).toBeInTheDocument();
  });

  // Filter by description
  it("filter input narrows by description", () => {
    const skills = [
      makeSkill({
        id: "1",
        slug: "skill-a",
        name: "Skill A",
        description: "Condenses documents",
      }),
      makeSkill({
        id: "2",
        slug: "skill-b",
        name: "Skill B",
        description: "Translates between languages",
      }),
    ];
    render(<SkillsPanel {...DEFAULT_PROPS} skills={skills} />);

    const input = screen.getByTestId("skills-search-input");
    fireEvent.change(input, { target: { value: "Translates" } });

    expect(screen.queryByText("Skill A")).not.toBeInTheDocument();
    expect(screen.getByText("Skill B")).toBeInTheDocument();
  });

  // (g) Empty state when skills=[]
  it("shows empty state when no skills are provided", () => {
    render(<SkillsPanel {...DEFAULT_PROPS} skills={[]} />);
    expect(screen.getByTestId("skills-empty-state")).toBeInTheDocument();
    expect(
      screen.getByText(/No skills installed in this workspace yet/),
    ).toBeInTheDocument();
  });

  // (h) Empty state when filter matches nothing
  it("shows empty state with different message when filter matches nothing", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ name: "Summarize Text" })]}
      />,
    );

    const input = screen.getByTestId("skills-search-input");
    fireEvent.change(input, { target: { value: "xyznotexist" } });

    expect(screen.getByTestId("skills-empty-state")).toBeInTheDocument();
    expect(screen.getByText(/No skills match your search/)).toBeInTheDocument();
  });

  // (i) Skill count label matches visible results
  it("shows correct count label for filtered results", () => {
    const skills = [
      makeSkill({ id: "1", slug: "skill-a", name: "Skill A" }),
      makeSkill({ id: "2", slug: "skill-b", name: "Skill B" }),
    ];
    render(<SkillsPanel {...DEFAULT_PROPS} skills={skills} />);

    // Initially all 2 skills shown
    expect(screen.getByText(/2 skills/)).toBeInTheDocument();

    // Filter to 1
    const input = screen.getByTestId("skills-search-input");
    fireEvent.change(input, { target: { value: "Skill A" } });

    expect(screen.getByText(/1 skill/)).toBeInTheDocument();
  });

  // (j) Detail link has correct href
  it("detail link points to the correct skill detail URL", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ slug: "summarize-text" })]}
      />,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "/acme/main/workbench/tools/skills/summarize-text",
    );
  });

  // (j2) Detail link encodes the slug
  it("detail link URL-encodes the skill slug", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ slug: "slug with spaces" })]}
      />,
    );

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toContain("slug%20with%20spaces");
  });

  // Renders version
  it("renders the active version in a monospaced cell", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ activeVersion: "2.0.0" })]}
      />,
    );
    expect(screen.getByText("2.0.0")).toBeInTheDocument();
  });

  // Renders em-dash for null version
  it("renders em-dash for null activeVersion", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ activeVersion: null })]}
      />,
    );
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  // Usage count
  it("renders the usage count", () => {
    render(
      <SkillsPanel
        {...DEFAULT_PROPS}
        skills={[makeSkill({ usageCount: 1234 })]}
      />,
    );
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });
});

describe("SkillsPanelSkeleton", () => {
  it("renders skeleton placeholders without crashing", () => {
    render(<SkillsPanelSkeleton />);
    const skeletons = screen.getAllByTestId("skeleton");
    expect(skeletons.length).toBeGreaterThan(0);
  });
});
