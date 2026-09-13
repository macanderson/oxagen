// @vitest-environment jsdom
/**
 * markdown-message.mentions.test.tsx
 *
 * The @-mention rendering path through MarkdownMessage: a message carrying a
 * serialized `[:type|:slug|:location|:label]` token is rewritten to an
 * oxagen-mention:// link (textWithMentionLinks) and rendered as an inspectable
 * MentionChip via the Streamdown `components.a` override; a plain message keeps
 * Streamdown's stock rendering, and ordinary https links are untouched.
 *
 * Streamdown is stubbed with a minimal markdown-link renderer that honours the
 * `components.a` override and `urlTransform` — the exact seam MarkdownMessage
 * relies on — so the token→chip pipeline is exercised without pulling in the
 * real Shiki/Mermaid renderer (heavy, Node/browser APIs). The stub spreads
 * nothing it does not own, so no sibling importOriginal mock loses exports.
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { serializeMention, type ChatMention } from "@oxagen/ai/mentions";

// The chip (rendered for mention links) reads route params for hydration.
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme", workspaceSlug: "default" }),
}));

// Inline popover stub — the chip's trigger becomes a plain button that still
// carries its data-testid, so mention-chip-<type> is queryable.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    children,
    "aria-label": ariaLabel,
    "data-testid": testid,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
    "data-testid"?: string;
    [key: string]: unknown;
  }) => (
    <button type="button" aria-label={ariaLabel} data-testid={testid}>
      {children}
    </button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Minimal Streamdown stub: renders `[text](url)` links through the
// `components.a` override (applying `urlTransform` first, like the real one) and
// leaves everything else as plain text nodes.
vi.mock("streamdown", () => ({
  defaultUrlTransform: (url: string) => url,
  Streamdown: ({
    children,
    components,
    urlTransform,
  }: {
    children: string;
    components?: {
      a?: React.ComponentType<React.AnchorHTMLAttributes<HTMLAnchorElement>>;
    };
    urlTransform?: (url: string, key: string, node: unknown) => string | null;
  }) => {
    const nodes: React.ReactNode[] = [];
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
    let last = 0;
    let key = 0;
    let match: RegExpExecArray | null;
    while ((match = linkRe.exec(children)) !== null) {
      if (match.index > last) nodes.push(children.slice(last, match.index));
      const text = match[1]!;
      const rawHref = match[2]!;
      const href = urlTransform
        ? (urlTransform(rawHref, "href", null) ?? undefined)
        : rawHref;
      const Anchor = components?.a;
      nodes.push(
        Anchor ? (
          <Anchor key={key++} href={href}>
            {text}
          </Anchor>
        ) : (
          <a key={key++} href={href}>
            {text}
          </a>
        ),
      );
      last = match.index + match[0]!.length;
    }
    if (last < children.length) nodes.push(children.slice(last));
    return <div data-testid="streamdown">{nodes}</div>;
  },
}));

vi.mock("@streamdown/code", () => ({
  createCodePlugin: () => ({ name: "code" }),
}));
vi.mock("@streamdown/mermaid", () => ({
  createMermaidPlugin: () => ({ name: "mermaid" }),
}));

import { MarkdownMessage } from "./markdown-message";

const fileMention: ChatMention = {
  type: "file",
  slug: "apps/app/src/proxy.ts",
  location: "apps/app/src/proxy.ts",
  label: "proxy.ts",
};

beforeEach(() => {
  // Chip hydration would fetch on open; nothing opens here, but stub it so a
  // stray call can never hit the network.
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarkdownMessage — mention tokens", () => {
  it("renders a serialized token as a mention chip, not raw token text", () => {
    const token = serializeMention(fileMention);
    render(<MarkdownMessage>{`please review ${token} today`}</MarkdownMessage>);

    const chip = screen.getByTestId("mention-chip-file");
    expect(chip).toHaveTextContent("proxy.ts");

    // The raw `[:file|…]` token must never survive into the rendered output.
    const out = screen.getByTestId("streamdown").textContent ?? "";
    expect(out).not.toContain(token);
    expect(out).not.toContain("[:file");
  });

  it("leaves an ordinary markdown message untouched (no chip)", () => {
    render(
      <MarkdownMessage>{"## Heading\n\nJust plain text."}</MarkdownMessage>,
    );
    expect(screen.queryByTestId("mention-chip-file")).toBeNull();
    expect(screen.getByTestId("streamdown")).toHaveTextContent(
      "Just plain text.",
    );
  });

  it("renders a mention chip while keeping a real https link an anchor", () => {
    const token = serializeMention(fileMention);
    render(
      <MarkdownMessage>{`see [docs](https://example.com) and ${token}`}</MarkdownMessage>,
    );

    // The token becomes a chip…
    expect(screen.getByTestId("mention-chip-file")).toBeInTheDocument();
    // …and the ordinary link is still a navigable anchor, not a chip.
    const anchor = screen.getByRole("link", { name: "docs" });
    expect(anchor).toHaveAttribute("href", "https://example.com");
  });
});
