// @vitest-environment jsdom
/**
 * image-preview.test.tsx
 *
 * Render tests for ImagePreview:
 *   - Placeholder state when no URL / placeholder=true
 *   - Normal state renders with provided URL
 *   - Renders alt text
 *   - Shows errorReason in placeholder state
 *   - Shows prompt in placeholder state
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ImagePreview from "./image-preview";

afterEach(cleanup);

// Stub next/image so jsdom can handle it
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

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    ImageOff: vi.fn(() => <span data-testid="icon-image-off" />),
  };
});

describe("ImagePreview", () => {
  it("renders the placeholder state when placeholder=true", () => {
    render(<ImagePreview alt="Test" placeholder />);
    expect(
      screen.getByText("Image generation unavailable"),
    ).toBeInTheDocument();
  });

  it("renders placeholder when neither url nor dataUri is provided", () => {
    render(<ImagePreview alt="Test" />);
    expect(
      screen.getByText("Image generation unavailable"),
    ).toBeInTheDocument();
  });

  it("renders the image when url is provided", () => {
    render(<ImagePreview url="/api/v1/assets/gen_abc" alt="My image" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "/api/v1/assets/gen_abc");
    expect(img).toHaveAttribute("alt", "My image");
  });

  it("renders the image when dataUri is provided", () => {
    const dataUri = "data:image/png;base64,ABC==";
    render(<ImagePreview dataUri={dataUri} alt="Data URI image" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", dataUri);
  });

  it("prefers url over dataUri when both provided", () => {
    render(
      <ImagePreview
        url="/api/v1/assets/gen_xyz"
        dataUri="data:image/png;base64,ABC=="
        alt="Preferred URL"
      />,
    );
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "/api/v1/assets/gen_xyz");
  });

  it("shows errorReason in placeholder state", () => {
    render(
      <ImagePreview
        alt="Test"
        placeholder
        errorReason="API key not configured"
      />,
    );
    expect(
      screen.getByText("Generation failed: API key not configured"),
    ).toBeInTheDocument();
  });

  it("shows default unavailable text when no errorReason", () => {
    render(<ImagePreview alt="Test" placeholder />);
    expect(
      screen.getByText("Image generation is not enabled."),
    ).toBeInTheDocument();
  });

  it("shows prompt in placeholder state", () => {
    render(<ImagePreview alt="Test" placeholder prompt="A futuristic city" />);
    expect(screen.getByText(/A futuristic city/)).toBeInTheDocument();
  });

  it("figure role has aria-label matching alt when image renders", () => {
    render(<ImagePreview url="/api/v1/assets/gen_abc" alt="My alt text" />);
    expect(screen.getByRole("figure")).toHaveAttribute(
      "aria-label",
      "My alt text",
    );
  });

  it("figure role has aria-label 'Image generation unavailable' in placeholder", () => {
    render(<ImagePreview alt="Test" placeholder />);
    expect(screen.getByRole("figure")).toHaveAttribute(
      "aria-label",
      "Image generation unavailable",
    );
  });

  it("renders ImageOff icon in placeholder state", () => {
    render(<ImagePreview alt="Test" placeholder />);
    expect(screen.getByTestId("icon-image-off")).toBeInTheDocument();
  });
});
