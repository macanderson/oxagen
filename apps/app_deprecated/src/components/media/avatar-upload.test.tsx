// @vitest-environment jsdom
/**
 * avatar-upload.test.tsx — render tests for AvatarUpload.
 *
 * Covers:
 *   - Renders "Upload photo" button when no value
 *   - Renders "Change photo" button when value is set
 *   - Shows fallback initial when no image
 *   - Shows an img when value is provided
 *   - Disabled state forwards to the button
 *   - Circle vs square shape classes applied to preview
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AvatarUpload } from "./avatar-upload";

afterEach(cleanup);

// Mock next/image
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

// Mock react-easy-crop (it relies on canvas APIs not available in jsdom)
vi.mock("react-easy-crop", () => ({
  default: () => <div data-testid="cropper" />,
}));

// Mock the CSS import
vi.mock("react-easy-crop/react-easy-crop.css", () => ({}));

describe("AvatarUpload — no image", () => {
  it("renders 'Upload photo' button when value is null", () => {
    render(<AvatarUpload value={null} onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /upload avatar photo/i }),
    ).toBeInTheDocument();
  });

  it("shows fallback initial when no image and fallback is provided", () => {
    render(<AvatarUpload value={null} onChange={vi.fn()} fallback="A" />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });
});

describe("AvatarUpload — with image", () => {
  it("renders 'Change photo' button when value is set", () => {
    render(
      <AvatarUpload
        value="https://example.com/avatar.png"
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /change avatar photo/i }),
    ).toBeInTheDocument();
  });

  it("renders an img element with the provided src", () => {
    render(
      <AvatarUpload
        value="https://example.com/avatar.png"
        onChange={vi.fn()}
      />,
    );
    // The component renders alt="Avatar" on the preview image
    const img = screen.getByAltText("Avatar");
    expect(img).toHaveAttribute("src", "https://example.com/avatar.png");
  });
});

describe("AvatarUpload — disabled", () => {
  it("disables the trigger button when disabled=true", () => {
    render(<AvatarUpload value={null} onChange={vi.fn()} disabled />);
    expect(
      screen.getByRole("button", { name: /upload avatar photo/i }),
    ).toBeDisabled();
  });
});

describe("AvatarUpload — shape", () => {
  it("applies rounded-full to the preview when shape='circle' (default)", () => {
    const { container } = render(
      <AvatarUpload value={null} onChange={vi.fn()} />,
    );
    const preview = container.querySelector(".rounded-full");
    expect(preview).toBeTruthy();
  });

  it("applies rounded-md to the preview when shape='square'", () => {
    const { container } = render(
      <AvatarUpload value={null} onChange={vi.fn()} shape="square" />,
    );
    // The outer preview wrapper should have rounded-md instead of rounded-full
    const preview = container.querySelector(".rounded-md");
    expect(preview).toBeTruthy();
  });
});
