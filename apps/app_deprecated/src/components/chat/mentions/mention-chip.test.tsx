// @vitest-environment jsdom
/**
 * mention-chip.test.tsx — the reference-citation rule for @-mentions, in tests.
 *
 * A mention is shown as a type icon + human label chip (testid
 * mention-chip-<type>), never by its raw slug: the slug lives only inside the
 * inspect popover (as a CopyableId). Chips reconstructed from transcript tokens
 * carry no property bag, so on first open they hydrate lazily from
 * /api/reference-search; when the composer already knows the bag (properties
 * prop), no fetch happens.
 *
 * The Base UI popover is stubbed inline (same idiom as node-ref.test.tsx) so its
 * portal/floating behaviour — not our concern — never runs in jsdom; the stub
 * additionally captures onOpenChange so a trigger click can simulate opening and
 * drive the hydration path.
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMention } from "@oxagen/ai/mentions";

// The chip reads the tenant scope for hydration from the route params.
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme", workspaceSlug: "default" }),
}));

// Inline popover stub. Capturing onOpenChange lets a trigger click stand in for
// "popover opened", which is exactly what fires the lazy-hydration fetch.
const popover = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    popover.onOpenChange = onOpenChange;
    return <>{children}</>;
  },
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
    <button
      type="button"
      aria-label={ariaLabel}
      data-testid={testid}
      onClick={() => popover.onOpenChange?.(true)}
    >
      {children}
    </button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-popup">{children}</div>
  ),
}));

import { MentionChip } from "./mention-chip";

const fileMention: ChatMention = {
  type: "file",
  slug: "apps/app/src/proxy.ts",
  location: "apps/app/src/proxy.ts",
  label: "proxy.ts",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ results: [] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  popover.onOpenChange = undefined;
});

describe("MentionChip", () => {
  it("renders the type icon + human label under the type testid", () => {
    render(<MentionChip mention={fileMention} properties={{ foo: "bar" }} />);
    const chip = screen.getByTestId("mention-chip-file");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("proxy.ts");
  });

  it("never shows the raw slug in the chip itself — only inside the popover", () => {
    render(<MentionChip mention={fileMention} properties={{ foo: "bar" }} />);
    const chip = screen.getByTestId("mention-chip-file");
    // The chip renders the label, not the slug path.
    expect(chip.textContent).not.toContain(fileMention.slug);
    expect(within(chip).queryByText(fileMention.slug)).toBeNull();
    // The slug is reachable only through the popover's copyable id.
    expect(
      screen.getByRole("button", { name: `Copy ID ${fileMention.slug}` }),
    ).toBeInTheDocument();
  });

  it("renders a remove affordance and fires onRemove when clicked", async () => {
    const onRemove = vi.fn();
    render(
      <MentionChip mention={fileMention} properties={{}} onRemove={onRemove} />,
    );
    const removeBtn = screen.getByRole("button", {
      name: `Remove mention ${fileMention.label}`,
    });
    await userEvent.click(removeBtn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("omits the remove affordance when onRemove is not provided", () => {
    render(<MentionChip mention={fileMention} properties={{}} />);
    expect(
      screen.queryByRole("button", {
        name: `Remove mention ${fileMention.label}`,
      }),
    ).toBeNull();
  });

  it("hydrates the property bag from /api/reference-search on first open", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            type: "file",
            slug: fileMention.slug,
            location: fileMention.location,
            label: fileMention.label,
            description: "d",
            properties: { foo: "bar" },
          },
        ],
      }),
    });
    // No `properties` prop → the chip must resolve them lazily.
    render(<MentionChip mention={fileMention} />);
    await userEvent.click(screen.getByTestId("mention-chip-file"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/reference-search");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      slug: string;
      types: string[];
      orgSlug: string;
      workspaceSlug: string;
    };
    expect(body.slug).toBe(fileMention.slug);
    expect(body.types).toEqual(["file"]);
    expect(body.orgSlug).toBe("acme");
    expect(body.workspaceSlug).toBe("default");
  });

  it("does not fetch when the property bag is already known", async () => {
    render(<MentionChip mention={fileMention} properties={{ foo: "bar" }} />);
    await userEvent.click(screen.getByTestId("mention-chip-file"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
