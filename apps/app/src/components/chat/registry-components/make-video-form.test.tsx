// @vitest-environment jsdom
/**
 * make-video-form.test.tsx
 *
 * Render + interaction tests for MakeVideoForm:
 *   - Renders prompt textarea
 *   - Pre-fills prompt from props
 *   - Submit button disabled when prompt is empty
 *   - Shows error when videoGenerateAction fails
 *   - Shows queued state when action succeeds
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

vi.mock("@/app/actions/video.generate.action", () => ({
  videoGenerateAction: vi.fn(),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    "aria-busy": ariaBusy,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: string;
    "aria-busy"?: boolean;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-busy={ariaBusy}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    htmlFor,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
  }) => <label htmlFor={htmlFor}>{children}</label>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({
    children,
    id,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    id?: string;
    "aria-label"?: string;
  }) => (
    <button id={id} aria-label={ariaLabel} type="button">
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <option value={value}>{children}</option>,
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Film: vi.fn(() => <span />),
    Clock: vi.fn(() => <span />),
    LayoutTemplate: vi.fn(() => <span />),
    Wand2: vi.fn(() => <span />),
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("MakeVideoForm", () => {
  it("renders form with aria-label 'Generate video'", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: true,
      queued: true,
      jobId: "job_123",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm />);
    expect(
      screen.getByRole("form", { name: "Generate video" }),
    ).toBeInTheDocument();
  });

  it("renders Prompt textarea", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: true,
      queued: true,
      jobId: "job_123",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm />);
    expect(
      screen.getByPlaceholderText("Describe the video you want to generate…"),
    ).toBeInTheDocument();
  });

  it("pre-fills prompt from props", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: true,
      queued: true,
      jobId: "job_123",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm prompt="A sunset over the ocean" />);
    const textarea = screen.getByPlaceholderText(
      "Describe the video you want to generate…",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("A sunset over the ocean");
  });

  it("submit button is disabled when prompt is empty", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: true,
      queued: true,
      jobId: "job_123",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm />);
    expect(
      screen.getByRole("button", { name: "Generate video" }),
    ).toBeDisabled();
  });

  it("submit button is enabled when prompt has text", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: true,
      queued: true,
      jobId: "job_123",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm prompt="A sunset over the ocean" />);
    expect(
      screen.getByRole("button", { name: "Generate video" }),
    ).not.toBeDisabled();
  });

  it("renders duration and aspect ratio inputs", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: true,
      queued: true,
      jobId: "job_123",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm />);
    expect(
      screen.getByRole("spinbutton", { name: "Duration in seconds" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Aspect ratio" }),
    ).toBeInTheDocument();
  });

  it("shows error when videoGenerateAction fails", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: false,
      error: "Video pipeline unavailable",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm prompt="A sunrise" orgSlug="my-org" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Generate video" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Video pipeline unavailable",
      );
    });
  });

  it("shows queued state when action succeeds", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: true,
      queued: true,
      jobId: "job_abc",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm prompt="A sunrise" orgSlug="my-org" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Generate video" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Video queued")).toBeInTheDocument();
    });
  });

  it("shows jobId in queued state", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: true,
      queued: true,
      jobId: "job_abc",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm prompt="A sunrise" orgSlug="my-org" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Generate video" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/job_abc/)).toBeInTheDocument();
    });
  });

  it("shows prompt in the queued state as italic caption", async () => {
    const { videoGenerateAction } = await import(
      "@/app/actions/video.generate.action"
    );
    vi.mocked(videoGenerateAction).mockResolvedValue({
      ok: true,
      queued: true,
      jobId: "job_abc",
    });

    const { default: MakeVideoForm } = await import("./make-video-form");
    render(<MakeVideoForm prompt="A sunrise" orgSlug="my-org" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Generate video" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/A sunrise/)).toBeInTheDocument();
    });
  });
});
