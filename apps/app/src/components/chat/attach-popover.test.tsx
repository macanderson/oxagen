// @vitest-environment jsdom
/**
 * attach-popover.test.tsx
 *
 * The chat_ux_v2 desktop attach popover (anchored menu opened by the
 * condensed row's plus button). Mocks `@/components/ui/popover` the same
 * way session-settings.test.tsx does (`PopoverTrigger`/`PopoverClose` clone
 * their `render` element with `children` inside — the Base UI `render`-prop
 * slot pattern), so the Popup's content is directly assertable in jsdom.
 *
 * Covers: exactly one "Upload files" row (no "Record voice" — the server
 * has no "audio" asset kind, see packages/storage/src/assets.ts), its
 * hidden input's accept spans all three kinds the server supports, picking
 * files routes to onPickFiles, and the plus button's disabled state is
 * forwarded.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
    "aria-label": ariaLabel,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      {...rest}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    render,
    children,
  }: {
    render: React.ReactElement;
    children?: React.ReactNode;
  }) => React.cloneElement(render, undefined, children),
  PopoverClose: ({
    render,
    children,
  }: {
    render: React.ReactElement;
    children?: React.ReactNode;
  }) => React.cloneElement(render, undefined, children),
  PopoverPopup: ({
    children,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    className?: string;
    "data-testid"?: string;
  }) => <div data-testid={testId ?? "attach-popover"}>{children}</div>,
}));

import { AttachPopover } from "./attach-popover";

describe("AttachPopover", () => {
  it("renders the plus trigger and exactly one 'Upload files' row — no Record voice row", () => {
    render(<AttachPopover onPickFiles={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload files" })).toBeInTheDocument();
    // The server has no "audio" asset kind (packages/storage/src/assets.ts)
    // — a voice-recording row would 415 on every attempt, so it must not exist.
    expect(
      screen.queryByRole("button", { name: /record voice/i }),
    ).not.toBeInTheDocument();
  });

  it("the hidden input accepts every server-supported kind (image, video, document/pdf)", () => {
    const { container } = render(<AttachPopover onPickFiles={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe("image/*,video/*,application/pdf");
    expect(input.multiple).toBe(true);
  });

  it("clicking 'Upload files' opens the hidden input; picking files calls onPickFiles", async () => {
    const user = userEvent.setup();
    const onPickFiles = vi.fn();
    const { container } = render(<AttachPopover onPickFiles={onPickFiles} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.click(screen.getByRole("button", { name: "Upload files" }));
    await user.upload(
      input,
      new File(["p"], "spec.pdf", { type: "application/pdf" }),
    );

    expect(onPickFiles).toHaveBeenCalledTimes(1);
    const files = onPickFiles.mock.calls[0]![0] as FileList;
    expect(files[0]!.name).toBe("spec.pdf");
  });

  it("forwards disabled to the plus trigger", () => {
    render(<AttachPopover disabled onPickFiles={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeDisabled();
  });

  it("is not disabled by default", () => {
    render(<AttachPopover onPickFiles={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add attachment" })).not.toBeDisabled();
  });
});
