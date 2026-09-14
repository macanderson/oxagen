// @vitest-environment jsdom
/**
 * field-renderer.test.tsx — Unit tests for FieldRenderer and validateField.
 *
 * Covers: all 13 widget types render, validateField rules, error display,
 * conditional visibility.
 */

import { render, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { validateField } from "./field-renderer";
import type { schemaFieldSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";
import type { z } from "zod";

afterEach(cleanup);

type SchemaField = z.infer<typeof schemaFieldSchema>;

// ── validateField ─────────────────────────────────────────────────────────────

describe("validateField — required", () => {
  const field: SchemaField = {
    key: "name",
    label: "Name",
    widget: "text",
    validation: { required: true },
  };

  it("returns 'Required' when value is empty string", () => {
    expect(validateField(field, "")).toBe("Required");
  });

  it("returns 'Required' when value is undefined", () => {
    expect(validateField(field, undefined)).toBe("Required");
  });

  it("returns 'Required' when value is null", () => {
    expect(validateField(field, null)).toBe("Required");
  });

  it("returns 'Required' when array is empty", () => {
    const arrField: SchemaField = {
      key: "tags",
      label: "Tags",
      widget: "tag-input",
      validation: { required: true },
    };
    expect(validateField(arrField, [])).toBe("Required");
  });

  it("returns null when value is provided", () => {
    expect(validateField(field, "hello")).toBeNull();
  });
});

describe("validateField — pattern", () => {
  const field: SchemaField = {
    key: "slug",
    label: "Slug",
    widget: "text",
    validation: { pattern: "^[a-z0-9-]+$" },
  };

  it("returns error when pattern does not match", () => {
    expect(validateField(field, "Hello World")).toBe("Invalid format");
  });

  it("returns null when pattern matches", () => {
    expect(validateField(field, "valid-slug-123")).toBeNull();
  });
});

describe("validateField — number min/max", () => {
  const field: SchemaField = {
    key: "depth",
    label: "Depth",
    widget: "number",
    validation: { min: 1, max: 100 },
  };

  it("returns error when below min", () => {
    expect(validateField(field, 0)).toBe("Minimum value is 1");
  });

  it("returns error when above max", () => {
    expect(validateField(field, 200)).toBe("Maximum value is 100");
  });

  it("returns null at min boundary", () => {
    expect(validateField(field, 1)).toBeNull();
  });

  it("returns null at max boundary", () => {
    expect(validateField(field, 100)).toBeNull();
  });
});

describe("validateField — array minItems/maxItems", () => {
  const field: SchemaField = {
    key: "orgs",
    label: "Orgs",
    widget: "tag-input",
    validation: { minItems: 1, maxItems: 3 },
  };

  it("returns error when below minItems", () => {
    expect(validateField(field, [])).toBe("At least 1 item required");
  });

  it("returns error when above maxItems", () => {
    expect(validateField(field, ["a", "b", "c", "d"])).toBe(
      "At most 3 items allowed",
    );
  });

  it("returns null when within bounds", () => {
    expect(validateField(field, ["a", "b"])).toBeNull();
  });
});

describe("validateField — itemPattern", () => {
  const field: SchemaField = {
    key: "repos",
    label: "Repos",
    widget: "tag-input",
    validation: { itemPattern: "^[a-z]+/[a-z]+$" },
  };

  it("returns error when an item does not match itemPattern", () => {
    expect(validateField(field, ["valid/repo", "INVALID"])).toBe(
      `"INVALID" is not a valid format`,
    );
  });

  it("returns null when all items match itemPattern", () => {
    expect(validateField(field, ["owner/repo", "other/project"])).toBeNull();
  });
});

describe("validateField — no validation", () => {
  it("returns null when no validation rule defined", () => {
    const field: SchemaField = {
      key: "notes",
      label: "Notes",
      widget: "textarea",
    };
    expect(validateField(field, "anything")).toBeNull();
    expect(validateField(field, undefined)).toBeNull();
  });
});

// ── FieldRenderer widget rendering ────────────────────────────────────────────
// We test widget rendering via a minimal provider wrapper.

import {
  ConnectorSchemaProvider,
  useConnectorSchema,
} from "./connector-schema-provider";
import { FieldRenderer } from "./field-renderer";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

const BASE_SCHEMA: ConnectorPluginSchema = {
  apiVersion: "oxagen.ai/v1alpha1",
  kind: "ConnectorPlugin",
  metadata: {
    id: "test",
    displayName: "Test",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
};

function Wrapper({
  field,
  initialValues = {},
}: {
  field: SchemaField;
  initialValues?: Record<string, unknown>;
}) {
  // Inject initial values by extending schema defaults via defaultValue
  const schema: ConnectorPluginSchema = {
    ...BASE_SCHEMA,
    config: { fields: [field] },
  };
  return (
    <ConnectorSchemaProvider
      pluginId="test"
      orgSlug="acme"
      workspaceSlug="main"
      initialSchema={schema}
    >
      <FieldRenderer field={field} />
    </ConnectorSchemaProvider>
  );
}

describe("FieldRenderer — text widget", () => {
  it("renders a text input", () => {
    const field: SchemaField = { key: "name", label: "Name", widget: "text" };
    render(<Wrapper field={field} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("renders the field label", () => {
    const field: SchemaField = { key: "name", label: "Name", widget: "text" };
    render(<Wrapper field={field} />);
    expect(screen.getByText("Name")).toBeInTheDocument();
  });

  it("shows required asterisk for required fields", () => {
    const field: SchemaField = {
      key: "n",
      label: "N",
      widget: "text",
      validation: { required: true },
    };
    render(<Wrapper field={field} />);
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    const field: SchemaField = {
      key: "n",
      label: "N",
      widget: "text",
      description: "Help text",
    };
    render(<Wrapper field={field} />);
    expect(screen.getByText("Help text")).toBeInTheDocument();
  });
});

describe("FieldRenderer — secret widget", () => {
  it("renders a password input", () => {
    const field: SchemaField = {
      key: "token",
      label: "Token",
      widget: "secret",
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Token");
    expect(input).toHaveAttribute("type", "password");
  });
});

describe("FieldRenderer — number widget", () => {
  it("renders a number input", () => {
    const field: SchemaField = {
      key: "depth",
      label: "Depth",
      widget: "number",
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Depth");
    expect(input).toHaveAttribute("type", "number");
  });

  it("sets min/max attributes from validation", () => {
    const field: SchemaField = {
      key: "depth",
      label: "Depth",
      widget: "number",
      validation: { min: 1, max: 730 },
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Depth");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "730");
  });
});

describe("FieldRenderer — textarea widget", () => {
  it("renders a textarea", () => {
    const field: SchemaField = {
      key: "notes",
      label: "Notes",
      widget: "textarea",
    };
    render(<Wrapper field={field} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});

describe("FieldRenderer — checkbox widget (Switch)", () => {
  it("renders a switch", () => {
    const field: SchemaField = {
      key: "enabled",
      label: "Enabled",
      widget: "checkbox",
      defaultValue: false,
    };
    render(<Wrapper field={field} />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("renders the label next to the switch", () => {
    const field: SchemaField = {
      key: "enabled",
      label: "Enable sync",
      widget: "checkbox",
      defaultValue: false,
    };
    render(<Wrapper field={field} />);
    expect(screen.getByText("Enable sync")).toBeInTheDocument();
  });
});

describe("FieldRenderer — select widget", () => {
  it("renders a select trigger", () => {
    const field: SchemaField = {
      key: "mode",
      label: "Mode",
      widget: "select",
      options: [
        { value: "a", label: "Option A" },
        { value: "b", label: "Option B" },
      ],
    };
    render(<Wrapper field={field} />);
    // Select trigger is a button
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});

describe("FieldRenderer — tag-input widget", () => {
  it("renders the tag input area", () => {
    const field: SchemaField = {
      key: "tags",
      label: "Tags",
      widget: "tag-input",
    };
    render(<Wrapper field={field} />);
    // The inner input should be present
    expect(screen.getByLabelText("Add tag")).toBeInTheDocument();
  });
});

describe("FieldRenderer — key-value widget", () => {
  it("renders the key-value editor", () => {
    const field: SchemaField = {
      key: "headers",
      label: "Headers",
      widget: "key-value",
    };
    render(<Wrapper field={field} />);
    expect(screen.getByText("Add row")).toBeInTheDocument();
  });
});

describe("FieldRenderer — multi-select widget", () => {
  it("renders multi-select toggle buttons", () => {
    const field: SchemaField = {
      key: "types",
      label: "Types",
      widget: "multi-select",
      options: [
        { value: "a", label: "Type A" },
        { value: "b", label: "Type B" },
      ],
    };
    render(<Wrapper field={field} />);
    expect(screen.getByRole("button", { name: "Type A" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Type B" })).toBeInTheDocument();
  });

  it("renders selected options with aria-pressed=true when defaultValue set", () => {
    const field: SchemaField = {
      key: "types",
      label: "Types",
      widget: "multi-select",
      defaultValue: ["a"],
      options: [
        { value: "a", label: "Type A" },
        { value: "b", label: "Type B" },
      ],
    };
    render(<Wrapper field={field} />);
    expect(screen.getByRole("button", { name: "Type A" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Type B" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("toggles selection when clicked", async () => {
    const field: SchemaField = {
      key: "types",
      label: "Types",
      widget: "multi-select",
      options: [{ value: "a", label: "Type A" }],
    };
    render(<Wrapper field={field} />);
    const btn = screen.getByRole("button", { name: "Type A" });
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });
});

describe("FieldRenderer — slider widget", () => {
  it("renders a slider with label", () => {
    const field: SchemaField = {
      key: "threshold",
      label: "Threshold",
      widget: "slider",
      defaultValue: 0.75,
      validation: { min: 0, max: 1 },
    };
    render(<Wrapper field={field} />);
    expect(screen.getByText("Threshold")).toBeInTheDocument();
    // Slider renders an input (thumb) with role="slider"
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  it("shows the current value display", () => {
    const field: SchemaField = {
      key: "depth",
      label: "Depth",
      widget: "slider",
      defaultValue: 50,
      validation: { min: 0, max: 100 },
    };
    render(<Wrapper field={field} />);
    expect(screen.getByText("50")).toBeInTheDocument();
  });
});

describe("FieldRenderer — email widget", () => {
  it("renders an email input", () => {
    const field: SchemaField = {
      key: "email",
      label: "Email",
      widget: "email",
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("type", "email");
  });
});

describe("FieldRenderer — url widget", () => {
  it("renders a url input", () => {
    const field: SchemaField = {
      key: "endpoint",
      label: "Endpoint",
      widget: "url",
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Endpoint");
    expect(input).toHaveAttribute("type", "url");
  });
});

describe("FieldRenderer — tag input interactions", () => {
  it("adds tag on Enter key", async () => {
    const field: SchemaField = {
      key: "tags",
      label: "Tags",
      widget: "tag-input",
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Add tag");
    await userEvent.type(input, "my-tag{Enter}");
    expect(screen.getByText("my-tag")).toBeInTheDocument();
  });

  it("adds tag on comma key", async () => {
    const field: SchemaField = {
      key: "tags",
      label: "Tags",
      widget: "tag-input",
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Add tag");
    await userEvent.type(input, "tag1,");
    expect(screen.getByText("tag1")).toBeInTheDocument();
  });

  it("removes last tag on backspace when input is empty", async () => {
    const schema: ConnectorPluginSchema = {
      ...BASE_SCHEMA,
      config: {
        fields: [
          {
            key: "tags",
            label: "Tags",
            widget: "tag-input",
            defaultValue: ["existing-tag"],
          },
        ],
      },
    };
    render(
      <ConnectorSchemaProvider
        pluginId="test"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={schema}
      >
        <FieldRenderer field={schema.config!.fields[0]!} />
      </ConnectorSchemaProvider>,
    );
    const input = screen.getByLabelText("Add tag");
    await userEvent.type(input, "{Backspace}");
    expect(screen.queryByText("existing-tag")).not.toBeInTheDocument();
  });

  it("shows itemPattern error for invalid tag", async () => {
    const field: SchemaField = {
      key: "orgs",
      label: "Orgs",
      widget: "tag-input",
      validation: { itemPattern: "^[a-z]+$" },
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Add tag");
    await userEvent.type(input, "INVALID{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(/"INVALID"/i);
  });

  it("shows duplicate tag error", async () => {
    const schema: ConnectorPluginSchema = {
      ...BASE_SCHEMA,
      config: {
        fields: [
          {
            key: "tags",
            label: "Tags",
            widget: "tag-input",
            defaultValue: ["dup"],
          },
        ],
      },
    };
    render(
      <ConnectorSchemaProvider
        pluginId="test"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={schema}
      >
        <FieldRenderer field={schema.config!.fields[0]!} />
      </ConnectorSchemaProvider>,
    );
    const input = screen.getByLabelText("Add tag");
    await userEvent.type(input, "dup{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(/already added/i);
  });

  it("adds tag on blur when input has value", async () => {
    const field: SchemaField = {
      key: "tags",
      label: "Tags",
      widget: "tag-input",
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Add tag");
    await userEvent.type(input, "blur-tag");
    await userEvent.tab();
    expect(screen.getByText("blur-tag")).toBeInTheDocument();
  });
});

describe("FieldRenderer — checkbox interactions", () => {
  it("toggles switch when clicked", async () => {
    const field: SchemaField = {
      key: "enabled",
      label: "Enable feature",
      widget: "checkbox",
      defaultValue: false,
    };
    render(<Wrapper field={field} />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});

describe("FieldRenderer — secret-file widget", () => {
  it("renders the secret file upload zone", () => {
    const field: SchemaField = {
      key: "credentials",
      label: "Credentials JSON",
      widget: "secret-file",
    };
    render(<Wrapper field={field} />);
    expect(
      screen.getByRole("button", { name: /upload json file/i }),
    ).toBeInTheDocument();
  });

  it("shows the field label", () => {
    const field: SchemaField = {
      key: "credentials",
      label: "Service Account",
      widget: "secret-file",
    };
    render(<Wrapper field={field} />);
    expect(screen.getByText("Service Account")).toBeInTheDocument();
  });
});

describe("FieldRenderer — number interactions", () => {
  it("updates value when number input changes", async () => {
    const field: SchemaField = {
      key: "depth",
      label: "Depth",
      widget: "number",
      defaultValue: 90,
    };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Depth");
    await userEvent.clear(input);
    await userEvent.type(input, "180");
    expect(input).toHaveValue(180);
  });
});

describe("FieldRenderer — text interactions", () => {
  it("updates value when text input changes", async () => {
    const field: SchemaField = { key: "name", label: "Name", widget: "text" };
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Name");
    await userEvent.type(input, "my-org");
    expect(input).toHaveValue("my-org");
  });
});

describe("FieldRenderer — error display via context", () => {
  // Test that errors set in formState are shown once field is touched
  function WrapperWithError({
    field,
    error,
  }: {
    field: SchemaField;
    error: string;
  }) {
    const schema: ConnectorPluginSchema = {
      ...BASE_SCHEMA,
      config: { fields: [field] },
    };
    // Provide a pre-touched error by wrapping with a custom provider that injects errors
    return (
      <ConnectorSchemaProvider
        pluginId="test"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={schema}
      >
        <ErrorInjector fieldKey={field.key} errorMsg={error} />
        <FieldRenderer field={field} />
      </ConnectorSchemaProvider>
    );
  }

  function ErrorInjector({
    fieldKey,
    errorMsg,
  }: {
    fieldKey: string;
    errorMsg: string;
  }) {
    const ctx = useConnectorSchema();
    React.useEffect(() => {
      ctx.setErrors([{ field: fieldKey, message: errorMsg, code: "required" }]);
      ctx.touchField(fieldKey);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  it("shows error message for text field when touched", () => {
    const field: SchemaField = {
      key: "name",
      label: "Name",
      widget: "text",
      validation: { required: true },
    };
    render(<WrapperWithError field={field} error="Required" />);
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("shows error message for number field when touched", () => {
    const field: SchemaField = {
      key: "count",
      label: "Count",
      widget: "number",
    };
    render(<WrapperWithError field={field} error="Min value is 1" />);
    expect(screen.getByText("Min value is 1")).toBeInTheDocument();
  });

  it("shows error message for select field when touched", () => {
    const field: SchemaField = {
      key: "mode",
      label: "Mode",
      widget: "select",
      options: [{ value: "a", label: "A" }],
    };
    render(<WrapperWithError field={field} error="Selection required" />);
    expect(screen.getByText("Selection required")).toBeInTheDocument();
  });

  it("shows error message for secret field when touched", () => {
    const field: SchemaField = {
      key: "token",
      label: "Token",
      widget: "secret",
      validation: { required: true },
    };
    render(<WrapperWithError field={field} error="Required" />);
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("shows error message for textarea field when touched", () => {
    const field: SchemaField = {
      key: "notes",
      label: "Notes",
      widget: "textarea",
    };
    render(<WrapperWithError field={field} error="Too long" />);
    expect(screen.getByText("Too long")).toBeInTheDocument();
  });

  it("shows error message for checkbox field when touched", () => {
    const field: SchemaField = {
      key: "agree",
      label: "Agree",
      widget: "checkbox",
    };
    render(<WrapperWithError field={field} error="Must agree" />);
    expect(screen.getByText("Must agree")).toBeInTheDocument();
  });

  it("shows error message for tag-input field when touched", () => {
    const field: SchemaField = {
      key: "tags",
      label: "Tags",
      widget: "tag-input",
    };
    render(<WrapperWithError field={field} error="At least 1 required" />);
    expect(screen.getByText("At least 1 required")).toBeInTheDocument();
  });

  it("shows error message for secret-file field when touched", () => {
    const field: SchemaField = {
      key: "creds",
      label: "Credentials",
      widget: "secret-file",
    };
    render(<WrapperWithError field={field} error="File required" />);
    expect(screen.getByText("File required")).toBeInTheDocument();
  });
});

describe("FieldRenderer — secret-file onChange callback", () => {
  function ValueSetter({
    fieldKey,
    value,
  }: {
    fieldKey: string;
    value: unknown;
  }) {
    const ctx = useConnectorSchema();
    React.useEffect(() => {
      ctx.setFieldValue(fieldKey, value);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  it("calls setFieldValue when file is cleared via SecretFileUpload", async () => {
    const field: SchemaField = {
      key: "credentials",
      label: "Credentials JSON",
      widget: "secret-file",
    };
    const schema: ConnectorPluginSchema = {
      ...BASE_SCHEMA,
      config: { fields: [field] },
    };
    render(
      <ConnectorSchemaProvider
        pluginId="test"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={{ ...schema }}
      >
        <ValueSetter fieldKey="credentials" value="dGVzdA==" />
        <FieldRenderer field={field} />
      </ConnectorSchemaProvider>,
    );
    // When a value exists, SecretFileUpload renders a "Clear" button
    const clearBtn = await screen.findByRole("button", {
      name: /clear uploaded file/i,
    });
    await userEvent.click(clearBtn);
    // After clearing, the drop zone should appear again
    expect(
      screen.getByRole("button", { name: /upload json file/i }),
    ).toBeInTheDocument();
  });
});

describe("FieldRenderer — fallback for unknown widget type", () => {
  it("renders text input for unknown widget type", () => {
    // Force an unknown widget type via type cast
    const field = {
      key: "custom",
      label: "Custom Field",
      widget: "date",
    } as unknown as SchemaField;
    render(<Wrapper field={field} />);
    // Should render a text input (fallback)
    const input = screen.getByLabelText("Custom Field");
    expect(input.tagName.toLowerCase()).toBe("input");
  });

  it("updates value in fallback text input", async () => {
    const field = {
      key: "custom",
      label: "Custom",
      widget: "date",
    } as unknown as SchemaField;
    render(<Wrapper field={field} />);
    const input = screen.getByLabelText("Custom");
    await userEvent.type(input, "hello");
    expect(input).toHaveValue("hello");
  });
});

describe("FieldRenderer — conditional visibility (dependsOn)", () => {
  it("hides field when dependsOn condition is not met", () => {
    const schema: ConnectorPluginSchema = {
      ...BASE_SCHEMA,
      config: {
        fields: [
          { key: "mode", label: "Mode", widget: "text" },
          {
            key: "advanced",
            label: "Advanced option",
            widget: "text",
            dependsOn: { field: "mode", value: "advanced" },
          },
        ],
      },
    };
    render(
      <ConnectorSchemaProvider
        pluginId="test"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={schema}
      >
        {schema.config?.fields.map((f) => (
          <FieldRenderer key={f.key} field={f} />
        ))}
      </ConnectorSchemaProvider>,
    );
    // "Advanced option" label should NOT be visible since mode != "advanced"
    expect(screen.queryByText("Advanced option")).not.toBeInTheDocument();
  });
});
