// @vitest-environment jsdom
/**
 * entity-avatar.test.tsx — render tests for EntityAvatar covering all three
 * AvatarSpec kinds (image / designed / none), color-mode filters, and the
 * initials fallback logic.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EntityAvatar } from "./entity-avatar";
import { serializeDesignedAvatar } from "@/lib/avatar/spec";

afterEach(cleanup);

// Mock next/image the same way avatar-upload.test.tsx does — jsdom has no
// Next.js image optimization runtime.
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
    // eslint-disable-next-line @next/next/no-img-element -- jsdom test shim; real next/image requires Next.js runtime
    <img src={src} alt={alt} {...rest} />
  ),
}));

describe("EntityAvatar — image kind", () => {
  it("renders an img with the entity name as alt text", () => {
    render(
      <EntityAvatar value="https://cdn.example.com/a.png" name="Acme Corp" />,
    );
    const img = screen.getByAltText("Acme Corp avatar");
    expect(img).toHaveAttribute("src", "https://cdn.example.com/a.png");
  });

  it("rejects a non-https URL and falls back to initials", () => {
    render(
      <EntityAvatar value="http://cdn.example.com/a.png" name="Acme Corp" />,
    );
    expect(
      screen.queryByRole("img", { name: "Acme Corp avatar" }),
    ).not.toHaveAttribute("src");
    expect(screen.getByText("AC")).toBeInTheDocument();
  });
});

describe("EntityAvatar — designed kind", () => {
  it("renders the emoji tile with the background color and accessible label", () => {
    const value = serializeDesignedAvatar({
      emoji: "🦊",
      bg: "#f59e0b",
      mode: "full",
    });
    render(<EntityAvatar value={value} name="Fox Workspace" />);

    const tile = screen.getByRole("img", { name: "Fox Workspace avatar" });
    expect(tile).toHaveStyle({ backgroundColor: "#f59e0b" });
    expect(tile).toHaveTextContent("🦊");
  });

  it("applies no filter for mode='full'", () => {
    const value = serializeDesignedAvatar({
      emoji: "🦊",
      bg: "#f59e0b",
      mode: "full",
    });
    render(<EntityAvatar value={value} name="Fox" />);
    const glyph = screen.getByText("🦊");
    expect(glyph.style.filter).toBe("");
  });

  it("applies a white-silhouette filter for mode='mono-light'", () => {
    const value = serializeDesignedAvatar({
      emoji: "🦊",
      bg: "#f59e0b",
      mode: "mono-light",
    });
    render(<EntityAvatar value={value} name="Fox" />);
    const glyph = screen.getByText("🦊");
    expect(glyph.style.filter).toBe("brightness(0) invert(1)");
  });

  it("applies a black-silhouette filter for mode='mono-dark'", () => {
    const value = serializeDesignedAvatar({
      emoji: "🦊",
      bg: "#f59e0b",
      mode: "mono-dark",
    });
    render(<EntityAvatar value={value} name="Fox" />);
    const glyph = screen.getByText("🦊");
    expect(glyph.style.filter).toBe("brightness(0)");
  });

  it("hides the emoji glyph from the accessibility tree", () => {
    const value = serializeDesignedAvatar({
      emoji: "🦊",
      bg: "#f59e0b",
      mode: "full",
    });
    render(<EntityAvatar value={value} name="Fox" />);
    expect(screen.getByText("🦊")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("EntityAvatar — none kind (initials fallback)", () => {
  it("shows both initials for a two-word name", () => {
    render(<EntityAvatar value={null} name="Ada Lovelace" />);
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("shows a single initial for a one-word name", () => {
    render(<EntityAvatar value={null} name="Cher" />);
    expect(screen.getByText("C")).toBeInTheDocument();
  });

  it("takes only the first two words for a multi-word name", () => {
    render(<EntityAvatar value={null} name="Mary Jane Watson" />);
    expect(screen.getByText("MJ")).toBeInTheDocument();
  });

  it("falls back for undefined value", () => {
    render(<EntityAvatar value={undefined} name="Ada Lovelace" />);
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("falls back for a malformed designed avatar string", () => {
    render(<EntityAvatar value="avatar:v1:not-json" name="Ada Lovelace" />);
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("renders a fallback glyph for an empty/whitespace name", () => {
    render(<EntityAvatar value={null} name="   " />);
    expect(screen.getByText("?")).toBeInTheDocument();
  });
});

describe("EntityAvatar — shape + size", () => {
  it("applies rounded-full for shape='circle' (default)", () => {
    const { container } = render(<EntityAvatar value={null} name="Acme" />);
    expect(container.querySelector(".rounded-full")).toBeTruthy();
  });

  it("applies rounded-md for shape='square'", () => {
    const { container } = render(
      <EntityAvatar value={null} name="Acme" shape="square" />,
    );
    expect(container.querySelector(".rounded-md")).toBeTruthy();
  });

  it("applies the size-16 class for size='xl'", () => {
    const { container } = render(
      <EntityAvatar value={null} name="Acme" size="xl" />,
    );
    expect(container.querySelector(".size-16")).toBeTruthy();
  });

  it("defaults to the size-8 (md) class", () => {
    const { container } = render(<EntityAvatar value={null} name="Acme" />);
    expect(container.querySelector(".size-8")).toBeTruthy();
  });
});
