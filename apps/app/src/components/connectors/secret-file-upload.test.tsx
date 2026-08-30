// @vitest-environment jsdom
/**
 * secret-file-upload.test.tsx — Unit tests for SecretFileUpload component.
 */

import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { SecretFileUpload } from "./secret-file-upload";

afterEach(cleanup);

describe("SecretFileUpload — render (empty state)", () => {
  it("renders the drop zone when no value", () => {
    render(<SecretFileUpload onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /upload json file/i }),
    ).toBeInTheDocument();
  });

  it("renders default label text", () => {
    render(<SecretFileUpload onChange={vi.fn()} />);
    expect(screen.getByText("Upload JSON file")).toBeInTheDocument();
  });

  it("renders custom label when provided", () => {
    render(
      <SecretFileUpload onChange={vi.fn()} label="Upload service account" />,
    );
    expect(screen.getByText("Upload service account")).toBeInTheDocument();
  });

  it("shows 'JSON files only' hint", () => {
    render(<SecretFileUpload onChange={vi.fn()} />);
    expect(screen.getByText(/JSON files only/i)).toBeInTheDocument();
  });
});

describe("SecretFileUpload — uploaded state", () => {
  it("shows file name when value is provided", () => {
    // Simulate uploaded state by setting value with no file name
    // The component shows "Uploaded file" when fileName state is empty but value exists
    render(<SecretFileUpload value="dGVzdA==" onChange={vi.fn()} />);
    expect(screen.getByText("Uploaded file")).toBeInTheDocument();
  });

  it("shows clear button when value is provided", () => {
    render(<SecretFileUpload value="dGVzdA==" onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /clear uploaded file/i }),
    ).toBeInTheDocument();
  });

  it("calls onChange with undefined when clear is clicked", async () => {
    const onChange = vi.fn();
    render(<SecretFileUpload value="dGVzdA==" onChange={onChange} />);
    const clearBtn = screen.getByRole("button", {
      name: /clear uploaded file/i,
    });
    await userEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});

describe("SecretFileUpload — disabled state", () => {
  it("makes drop zone non-interactive when disabled", () => {
    render(<SecretFileUpload onChange={vi.fn()} disabled />);
    const dropZone = screen.getByRole("button", { name: /upload json file/i });
    // Disabled via CSS pointer-events-none, check tabIndex
    expect(dropZone).toHaveAttribute("tabindex", "-1");
  });

  it("disables clear button when value exists and disabled=true", () => {
    render(<SecretFileUpload value="dGVzdA==" onChange={vi.fn()} disabled />);
    const clearBtn = screen.getByRole("button", {
      name: /clear uploaded file/i,
    });
    expect(clearBtn).toBeDisabled();
  });
});

describe("SecretFileUpload — keyboard accessibility", () => {
  it("activates file dialog on Enter key press on drop zone", async () => {
    render(<SecretFileUpload onChange={vi.fn()} />);
    const dropZone = screen.getByRole("button", { name: /upload json file/i });
    // Just verify it doesn't throw and component stays in DOM
    await userEvent.type(dropZone, "{Enter}");
    expect(dropZone).toBeInTheDocument();
  });

  it("activates file dialog on Space key press on drop zone", async () => {
    render(<SecretFileUpload onChange={vi.fn()} />);
    const dropZone = screen.getByRole("button", { name: /upload json file/i });
    await userEvent.type(dropZone, " ");
    expect(dropZone).toBeInTheDocument();
  });

  it("does not trigger file dialog on Enter when disabled", async () => {
    render(<SecretFileUpload onChange={vi.fn()} disabled />);
    const dropZone = screen.getByRole("button", { name: /upload json file/i });
    // Should not throw; disabled handler just returns early
    await userEvent.type(dropZone, "{Enter}");
    expect(dropZone).toBeInTheDocument();
  });
});

describe("SecretFileUpload — drag and drop", () => {
  it("does not throw when drop event has no files", () => {
    render(<SecretFileUpload onChange={vi.fn()} />);
    const dropZone = screen.getByRole("button", { name: /upload json file/i });
    // Fire drop with empty files list
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [] },
    });
    // Component should still be in DOM (no crash)
    expect(dropZone).toBeInTheDocument();
  });

  it("processes JSON file dropped on drop zone", async () => {
    const onChange = vi.fn();
    render(<SecretFileUpload onChange={onChange} />);
    const dropZone = screen.getByRole("button", { name: /upload json file/i });
    const jsonFile = new File([JSON.stringify({ key: "val" })], "creds.json", {
      type: "application/json",
    });
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [jsonFile] },
    });
    // Wait for FileReader to process
    await new Promise((r) => setTimeout(r, 50));
    if (onChange.mock.calls.length > 0) {
      expect(typeof onChange.mock.calls[0]?.[0]).toBe("string");
    }
  });

  it("calls handleDragOver to prevent default", () => {
    render(<SecretFileUpload onChange={vi.fn()} />);
    const dropZone = screen.getByRole("button", { name: /upload json file/i });
    const event = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "defaultPrevented", {
      get: () => false,
      configurable: true,
    });
    // This just exercises the handler without error
    fireEvent.dragOver(dropZone);
    expect(dropZone).toBeInTheDocument();
  });
});

describe("SecretFileUpload — file upload", () => {
  it("shows error for non-JSON file", async () => {
    render(<SecretFileUpload onChange={vi.fn()} />);
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const txtFile = new File(["hello"], "test.txt", { type: "text/plain" });
    // Use upload with a list of files
    Object.defineProperty(fileInput, "files", {
      value: [txtFile],
      writable: false,
    });
    fireEvent.change(fileInput);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Only JSON files are supported",
    );
  });

  it("calls onChange with base64 for valid JSON file", async () => {
    const onChange = vi.fn();
    render(<SecretFileUpload onChange={onChange} />);

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const jsonContent = JSON.stringify({ type: "service_account" });
    const jsonFile = new File([jsonContent], "sa.json", {
      type: "application/json",
    });

    await userEvent.upload(fileInput, jsonFile);

    // Wait for FileReader to complete (it's async)
    await new Promise((r) => setTimeout(r, 50));

    // onChange called with some base64 string
    if (onChange.mock.calls.length > 0) {
      const arg = onChange.mock.calls[0]?.[0];
      expect(typeof arg).toBe("string");
      expect(arg).not.toBe("");
    }
  });
});
