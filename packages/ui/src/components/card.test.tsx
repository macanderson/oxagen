// @vitest-environment jsdom
/**
 * card.test.tsx — render tests for Card and all sub-parts.
 *
 * Covers: Card, CardHeader, CardTitle, CardDescription, CardPanel, CardFooter.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardPanel,
  CardFooter,
} from "./card";

afterEach(cleanup);

describe("Card — render", () => {
  it("renders its children", () => {
    const { getByText } = render(<Card>Card body</Card>);
    expect(getByText("Card body")).toBeInTheDocument();
  });

  it("includes rounded-xl and shadow classes", () => {
    const { container } = render(<Card>Content</Card>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("rounded-xl");
    expect(el.className).toContain("shadow");
  });

  it("merges custom className", () => {
    const { container } = render(<Card className="custom">Content</Card>);
    expect((container.firstChild as HTMLElement).className).toContain("custom");
  });
});

describe("CardHeader — render", () => {
  it("renders children", () => {
    const { getByText } = render(<CardHeader>Header</CardHeader>);
    expect(getByText("Header")).toBeInTheDocument();
  });

  it("renders a flat header (flex-col + header tokens)", () => {
    const { container } = render(<CardHeader>H</CardHeader>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("flex-col");
    // Flat skin: CardHeader blends with the card surface (px-6 py-4); only a
    // hairline border-b separates it from the body.
    expect(el.className).toContain("bg-card-header-bg");
    expect(el.className).toContain("text-card-header-fg");
    expect(el.className).toContain("px-6");
  });
});

describe("CardTitle — render", () => {
  it("renders as an h3", () => {
    const { getByRole } = render(<CardTitle>My Title</CardTitle>);
    expect(getByRole("heading", { name: "My Title" })).toBeInTheDocument();
  });

  it("includes font-semibold class", () => {
    const { getByRole } = render(<CardTitle>Title</CardTitle>);
    expect(getByRole("heading").className).toContain("font-semibold");
  });
});

describe("CardDescription — render", () => {
  it("renders as a paragraph with muted text class", () => {
    const { getByText } = render(
      <CardDescription>Some description</CardDescription>,
    );
    const el = getByText("Some description");
    expect(el.tagName.toLowerCase()).toBe("p");
    expect(el.className).toContain("text-muted-foreground");
  });
});

describe("CardPanel — render", () => {
  it("renders children with correct padding class", () => {
    const { container } = render(<CardPanel>Panel content</CardPanel>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("p-6");
  });
});

describe("CardFooter — render", () => {
  it("renders children with flex and p-6 classes", () => {
    const { container } = render(<CardFooter>Footer</CardFooter>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("flex");
    expect(el.className).toContain("p-6");
  });
});

describe("Card — composition", () => {
  it("renders all sub-parts together", () => {
    const { getByRole, getByText } = render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
        </CardHeader>
        <CardPanel>Body</CardPanel>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );
    expect(getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(getByText("Description")).toBeInTheDocument();
    expect(getByText("Body")).toBeInTheDocument();
    expect(getByText("Footer")).toBeInTheDocument();
  });
});
