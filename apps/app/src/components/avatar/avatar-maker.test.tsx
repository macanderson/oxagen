// @vitest-environment jsdom
/**
 * avatar-maker.test.tsx — interaction tests for AvatarMaker.
 *
 * Covers:
 *   - Renders the EntityAvatar trigger + "Edit avatar" button
 *   - Opening the dialog renders both Photo and Design tabs
 *   - Defaults to the Photo tab for a photo/none value, Design tab for a
 *     designed value
 *   - Pre-populates the Design tab (emoji, color, mode) from an existing
 *     designed avatar value
 *   - Picking an emoji + preset color + mode then Save calls onChange with
 *     the exact canonical avatar:v1: string
 *   - The emoji search filter narrows the grid
 *   - An invalid custom hex shows an error and disables Save
 *   - Cancel discards changes without calling onChange
 */

import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AvatarMaker } from "./avatar-maker";
import { serializeDesignedAvatar } from "@/lib/avatar/spec";

afterEach(cleanup);

// EntityAvatar renders next/image for photo avatars; jsdom has no Next.js
// image runtime, so stub it the same way avatar-upload.test.tsx does.
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

// The Photo tab pulls in react-easy-crop via crop-upload.tsx; stub it the
// same way avatar-upload.test.tsx does (canvas/measurement APIs aren't
// available in jsdom, and this suite never needs to render the cropper).
vi.mock("react-easy-crop", () => ({
  default: () => <div data-testid="cropper" />,
}));
vi.mock("react-easy-crop/react-easy-crop.css", () => ({}));

async function openDialog() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  return user;
}

describe("AvatarMaker — trigger", () => {
  it("renders the EntityAvatar preview and the Edit avatar button", () => {
    render(<AvatarMaker value={null} onChange={vi.fn()} name="Acme Team" />);
    expect(
      screen.getByRole("img", { name: "Acme Team avatar" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit avatar" }),
    ).toBeInTheDocument();
  });

  it("disables the trigger when disabled=true", () => {
    render(
      <AvatarMaker value={null} onChange={vi.fn()} name="Acme Team" disabled />,
    );
    expect(screen.getByRole("button", { name: "Edit avatar" })).toBeDisabled();
  });
});

describe("AvatarMaker — dialog + tabs", () => {
  it("opens the dialog with Photo and Design tabs", async () => {
    render(<AvatarMaker value={null} onChange={vi.fn()} name="Acme Team" />);
    await openDialog();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Photo" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Design" })).toBeInTheDocument();
  });

  it("defaults to the Photo tab when there is no avatar value", async () => {
    render(<AvatarMaker value={null} onChange={vi.fn()} name="Acme Team" />);
    await openDialog();

    expect(screen.getByRole("tab", { name: "Photo" })).toHaveAttribute(
      "data-active",
    );
    expect(
      screen.getByRole("button", { name: "Choose a photo" }),
    ).toBeInTheDocument();
  });

  it("defaults to the Photo tab when the current value is a photo URL", async () => {
    render(
      <AvatarMaker
        value="https://cdn.example.com/a.webp"
        onChange={vi.fn()}
        name="Acme Team"
      />,
    );
    await openDialog();

    expect(screen.getByRole("tab", { name: "Photo" })).toHaveAttribute(
      "data-active",
    );
  });

  it("defaults to the Design tab when the current value is a designed avatar", async () => {
    const value = serializeDesignedAvatar({
      emoji: "🦊",
      bg: "#f59e0b",
      mode: "full",
    });
    render(<AvatarMaker value={value} onChange={vi.fn()} name="Acme Team" />);
    await openDialog();

    expect(screen.getByRole("tab", { name: "Design" })).toHaveAttribute(
      "data-active",
    );
  });
});

describe("AvatarMaker — Design tab pre-population", () => {
  it("pre-populates emoji, color, and mode from the current designed value", async () => {
    const value = serializeDesignedAvatar({
      emoji: "🦊",
      bg: "#3b82f6",
      mode: "mono-light",
    });
    render(<AvatarMaker value={value} onChange={vi.fn()} name="Acme Team" />);
    await openDialog();

    // Emoji button for the fox is pressed.
    expect(screen.getByRole("button", { name: "fox" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Custom hex field reflects the current background.
    expect(
      screen.getByLabelText("Custom background color hex value"),
    ).toHaveValue("#3b82f6");
    // Color mode segmented control reflects the current mode.
    expect(screen.getByRole("button", { name: "Mono light" })).toHaveAttribute(
      "data-pressed",
    );
  });
});

describe("AvatarMaker — Design tab save flow", () => {
  it("calls onChange with the exact canonical string after picking emoji + color + mode", async () => {
    const onChange = vi.fn();
    render(<AvatarMaker value={null} onChange={onChange} name="Acme Team" />);
    const user = await openDialog();

    await user.click(screen.getByRole("tab", { name: "Design" }));
    await user.click(screen.getByRole("button", { name: "fox" }));
    await user.click(
      screen.getByRole("button", { name: "Background color #f59e0b" }),
    );
    await user.click(screen.getByRole("button", { name: "Mono dark" }));

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onChange).toHaveBeenCalledWith(
      'avatar:v1:{"emoji":"🦊","bg":"#f59e0b","mode":"mono-dark"}',
    );
  });

  it("narrows the emoji grid via the search filter", async () => {
    render(<AvatarMaker value={null} onChange={vi.fn()} name="Acme Team" />);
    const user = await openDialog();
    await user.click(screen.getByRole("tab", { name: "Design" }));

    expect(screen.getByRole("button", { name: "fox" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Icon"), "cat");

    expect(screen.getByRole("button", { name: "cat" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "fox" }),
    ).not.toBeInTheDocument();
  });

  it("filters the emoji grid to a single category when a category chip is clicked", async () => {
    render(<AvatarMaker value={null} onChange={vi.fn()} name="Acme Team" />);
    const user = await openDialog();
    await user.click(screen.getByRole("tab", { name: "Design" }));

    await user.click(screen.getByRole("button", { name: "Food" }));

    expect(screen.getByRole("button", { name: "pizza" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "fox" }),
    ).not.toBeInTheDocument();
  });

  it("shows an error and disables Save for an invalid custom hex value", async () => {
    render(<AvatarMaker value={null} onChange={vi.fn()} name="Acme Team" />);
    const user = await openDialog();
    await user.click(screen.getByRole("tab", { name: "Design" }));

    const hexInput = screen.getByLabelText("Custom background color hex value");
    await user.clear(hexInput);
    await user.type(hexInput, "not-a-color");

    expect(screen.getByRole("alert")).toHaveTextContent(/hex color/i);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("normalizes a valid custom hex value and enables Save", async () => {
    const onChange = vi.fn();
    render(<AvatarMaker value={null} onChange={onChange} name="Acme Team" />);
    const user = await openDialog();
    await user.click(screen.getByRole("tab", { name: "Design" }));

    const hexInput = screen.getByLabelText("Custom background color hex value");
    await user.clear(hexInput);
    await user.type(hexInput, "#ABCDEF");

    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onChange).toHaveBeenCalledWith(
      expect.stringContaining('"bg":"#abcdef"'),
    );
  });
});

describe("AvatarMaker — cancel", () => {
  it("discards changes and does not call onChange when Cancel is clicked", async () => {
    const onChange = vi.fn();
    render(<AvatarMaker value={null} onChange={onChange} name="Acme Team" />);
    const user = await openDialog();
    await user.click(screen.getByRole("tab", { name: "Design" }));
    await user.click(screen.getByRole("button", { name: "fox" }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("AvatarMaker — entityLabel copy", () => {
  it("mentions the entityLabel noun in the dialog description", async () => {
    render(
      <AvatarMaker
        value={null}
        onChange={vi.fn()}
        name="Acme Team"
        entityLabel="workspace"
      />,
    );
    await openDialog();

    expect(screen.getByText(/for this workspace/i)).toBeInTheDocument();
  });

  it("defaults to 'profile' when entityLabel is omitted", async () => {
    render(<AvatarMaker value={null} onChange={vi.fn()} name="Acme Team" />);
    await openDialog();

    expect(screen.getByText(/for this profile/i)).toBeInTheDocument();
  });
});
