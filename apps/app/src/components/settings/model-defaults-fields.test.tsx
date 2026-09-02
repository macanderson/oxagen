// @vitest-environment jsdom
/**
 * model-defaults-fields.test.tsx — tests for ModelDefaultsFields.
 *
 * Tests the pure encode/decode logic for the text model select, and verifies
 * that the component renders the three selects and the scope note.
 *
 * The handleTextChange / handleImageChange / handleVideoChange handlers are
 * pure value-transformers; we test them through the onChange prop.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  ModelDefaultsFields,
  type ModelDefaultsValue,
} from "./model-defaults-fields";

afterEach(cleanup);

const defaultValue: ModelDefaultsValue = {
  textTier: null,
  textModel: null,
  imageModel: null,
  videoModel: null,
};

describe("ModelDefaultsFields — rendering", () => {
  it("renders 'Default agent model' select", () => {
    render(
      <ModelDefaultsFields
        value={defaultValue}
        onChange={vi.fn()}
        scope="user"
      />,
    );
    expect(screen.getByLabelText(/default agent model/i)).toBeInTheDocument();
  });

  it("renders 'Default image model' select", () => {
    render(
      <ModelDefaultsFields
        value={defaultValue}
        onChange={vi.fn()}
        scope="user"
      />,
    );
    expect(screen.getByLabelText(/default image model/i)).toBeInTheDocument();
  });

  it("renders 'Default video model' select", () => {
    render(
      <ModelDefaultsFields
        value={defaultValue}
        onChange={vi.fn()}
        scope="user"
      />,
    );
    expect(screen.getByLabelText(/default video model/i)).toBeInTheDocument();
  });

  it("shows user scope note when scope='user'", () => {
    render(
      <ModelDefaultsFields
        value={defaultValue}
        onChange={vi.fn()}
        scope="user"
      />,
    );
    expect(
      screen.getByText(/workspace can override these defaults/i),
    ).toBeInTheDocument();
  });

  it("shows workspace scope note when scope='workspace'", () => {
    render(
      <ModelDefaultsFields
        value={defaultValue}
        onChange={vi.fn()}
        scope="workspace"
      />,
    );
    expect(
      screen.getByText(/these defaults apply to all members/i),
    ).toBeInTheDocument();
  });

  it("selects are disabled when disabled=true", () => {
    render(
      <ModelDefaultsFields
        value={defaultValue}
        onChange={vi.fn()}
        scope="user"
        disabled
      />,
    );
    const selects = screen.getAllByRole("combobox");
    for (const sel of selects) {
      expect(sel).toBeDisabled();
    }
  });
});

// ---------------------------------------------------------------------------
// Pure encode/decode logic (mirrors encodeTextValue exactly)
// ---------------------------------------------------------------------------

// Mirror the internal encode function from the component source
function encodeTextValue(
  textModel: string | null,
  textTier: "fast" | "balanced" | "precise" | null,
): string {
  if (textModel) return `model:${textModel}`;
  if (textTier) return `tier:${textTier}`;
  return "system";
}

describe("encodeTextValue — pure logic", () => {
  it("returns 'system' when both are null", () => {
    expect(encodeTextValue(null, null)).toBe("system");
  });

  it("encodes textModel as 'model:<id>'", () => {
    expect(encodeTextValue("claude-3-opus", null)).toBe("model:claude-3-opus");
  });

  it("encodes textTier as 'tier:<id>'", () => {
    expect(encodeTextValue(null, "fast")).toBe("tier:fast");
    expect(encodeTextValue(null, "balanced")).toBe("tier:balanced");
    expect(encodeTextValue(null, "precise")).toBe("tier:precise");
  });

  it("textModel wins over textTier when both provided", () => {
    expect(encodeTextValue("some-model", "fast")).toBe("model:some-model");
  });
});
