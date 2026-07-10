// @vitest-environment jsdom
/**
 * agent-avatar.test.tsx — the shared agent avatar: https image, avatar:v1
 * designed spec, and the deterministic initials fallback.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AgentAvatar, hueFromSlug } from "./agent-avatar";
import { serializeDesignedAvatar } from "@/lib/avatar/spec";

// jsdom has no Next.js image runtime — shim next/image to a plain <img>, as
// entity-avatar.test.tsx does.
vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    ...rest
  }: {
    src: string;
    alt: string;
    [key: string]: unknown;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element -- jsdom test shim
    <img src={src} alt={alt} {...rest} />
  ),
}));

afterEach(cleanup);

describe("AgentAvatar", () => {
  it("renders an <img> for an https avatar url", () => {
    render(
      <AgentAvatar
        avatarUrl="https://cdn.example.com/a.png"
        name="Coder"
        slug="coder"
      />,
    );
    const img = screen.getByAltText("Coder avatar");
    expect(img).toHaveAttribute("src", "https://cdn.example.com/a.png");
  });

  it("renders the designed emoji tile for an avatar:v1 spec", () => {
    const value = serializeDesignedAvatar({
      emoji: "🤖",
      bg: "#f59e0b",
      mode: "full",
    });
    render(<AgentAvatar avatarUrl={value} name="Coder" slug="coder" />);
    expect(screen.getByText("🤖")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Coder avatar" }),
    ).toBeInTheDocument();
  });

  it("renders deterministic initials on a gradient when avatarUrl is null", () => {
    render(
      <AgentAvatar avatarUrl={null} name="Code Helper" slug="code-helper" />,
    );
    const tile = screen.getByRole("img", { name: "Code Helper avatar" });
    expect(tile).toBeInTheDocument();
    expect(screen.getByText("CH")).toBeInTheDocument();
    expect(tile.getAttribute("style")).toContain("linear-gradient");
  });

  it("falls back to initials for a malformed spec (never a raw string)", () => {
    render(
      <AgentAvatar
        avatarUrl="avatar:v1:not-json"
        name="Broken Bot"
        slug="broken"
      />,
    );
    expect(screen.getByText("BB")).toBeInTheDocument();
  });
});

describe("hueFromSlug", () => {
  it("is deterministic for the same slug", () => {
    expect(hueFromSlug("code-helper")).toBe(hueFromSlug("code-helper"));
  });

  it("stays within 0..359", () => {
    for (const slug of ["a", "code-helper", "very-long-agent-slug-name", "x"]) {
      const h = hueFromSlug(slug);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
