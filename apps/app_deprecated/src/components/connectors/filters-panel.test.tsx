// @vitest-environment jsdom
/**
 * filters-panel.test.tsx — Unit tests for FiltersPanel.
 */

import { render, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { useConnectorSchema } from "./connector-schema-provider";
import { ConnectorSchemaProvider } from "./connector-schema-provider";
import { FiltersPanel } from "./filters-panel";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

afterEach(cleanup);

const PATH_AND_LABEL_SCHEMA: ConnectorPluginSchema = {
  apiVersion: "oxagen.ai/v1alpha1",
  kind: "ConnectorPlugin",
  metadata: {
    id: "test",
    displayName: "Test",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
  filters: {
    pathFilters: {
      enabled: true,
      defaultIgnore: ["node_modules/**", "dist/**"],
      appliesTo: ["source"],
    },
    labelFilters: {
      enabled: true,
      appliesTo: ["issue", "pull_request"],
    },
  },
};

const PATH_ONLY_SCHEMA: ConnectorPluginSchema = {
  ...PATH_AND_LABEL_SCHEMA,
  filters: {
    pathFilters: {
      enabled: true,
      defaultIgnore: ["dist/**"],
    },
    labelFilters: { enabled: false },
  },
};

const NO_FILTERS_SCHEMA: ConnectorPluginSchema = {
  ...PATH_AND_LABEL_SCHEMA,
  filters: {
    pathFilters: { enabled: false },
    labelFilters: { enabled: false },
  },
};

const NO_FILTERS_DEFINED_SCHEMA: ConnectorPluginSchema = {
  ...PATH_AND_LABEL_SCHEMA,
  filters: undefined,
};

function renderPanel(schema: ConnectorPluginSchema) {
  return render(
    <ConnectorSchemaProvider
      pluginId="test"
      orgSlug="acme"
      workspaceSlug="main"
      initialSchema={schema}
    >
      <FiltersPanel />
    </ConnectorSchemaProvider>,
  );
}

describe("FiltersPanel — no filters", () => {
  it("renders nothing when filters not defined", () => {
    const { container } = renderPanel(NO_FILTERS_DEFINED_SCHEMA);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when both path and label filters disabled", () => {
    const { container } = renderPanel(NO_FILTERS_SCHEMA);
    expect(container.firstChild).toBeNull();
  });
});

describe("FiltersPanel — path filters", () => {
  it("renders Path ignore patterns label", () => {
    renderPanel(PATH_ONLY_SCHEMA);
    expect(screen.getByText("Path ignore patterns")).toBeInTheDocument();
  });

  it("renders textarea with default patterns", () => {
    renderPanel(PATH_ONLY_SCHEMA);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("dist/**");
  });

  it("renders hint about glob patterns", () => {
    renderPanel(PATH_ONLY_SCHEMA);
    expect(screen.getByText(/One glob pattern per line/i)).toBeInTheDocument();
  });

  it("shows appliesTo info when provided", () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    expect(screen.getByText(/Applies to: source/i)).toBeInTheDocument();
  });
});

describe("FiltersPanel — label filters", () => {
  it("renders Label filters section", () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    expect(screen.getByText("Label filters")).toBeInTheDocument();
  });

  it("renders tag input for label filters", () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    expect(screen.getByLabelText("Add label filter")).toBeInTheDocument();
  });

  it("shows label filter description", () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    expect(
      screen.getByText(/Only sync items with these labels/i),
    ).toBeInTheDocument();
  });

  it("shows appliesTo for label filters", () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    expect(screen.getByText(/issue, pull_request/i)).toBeInTheDocument();
  });
});

describe("FiltersPanel — path and label together", () => {
  it("renders both path and label filter sections", () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    expect(screen.getByText("Path ignore patterns")).toBeInTheDocument();
    expect(screen.getByText("Label filters")).toBeInTheDocument();
  });

  it("allows typing a label filter", async () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    const labelInput = screen.getByLabelText("Add label filter");
    await userEvent.type(labelInput, "feature{enter}");
    // After pressing Enter, a tag should appear
    expect(screen.getByText("feature")).toBeInTheDocument();
  });

  it("allows removing a label filter tag", async () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    const labelInput = screen.getByLabelText("Add label filter");
    await userEvent.type(labelInput, "bug{enter}");
    expect(screen.getByText("bug")).toBeInTheDocument();
    const removeBtn = screen.getByRole("button", { name: /remove bug/i });
    await userEvent.click(removeBtn);
    expect(screen.queryByText("bug")).not.toBeInTheDocument();
  });

  it("does not add duplicate label filter tags", async () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    const labelInput = screen.getByLabelText("Add label filter");
    await userEvent.type(labelInput, "dup{enter}");
    expect(screen.getByText("dup")).toBeInTheDocument();
    // Type the same tag again — should not add a second
    await userEvent.type(labelInput, "dup{enter}");
    const tags = screen.getAllByText("dup");
    expect(tags).toHaveLength(1);
  });

  it("removes last label tag on Backspace when input is empty", async () => {
    renderPanel(PATH_AND_LABEL_SCHEMA);
    const labelInput = screen.getByLabelText("Add label filter");
    // Add two tags first
    await userEvent.type(labelInput, "first{enter}");
    await userEvent.type(labelInput, "second{enter}");
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
    // Press Backspace with empty input — should remove "second"
    await userEvent.type(labelInput, "{backspace}");
    expect(screen.queryByText("second")).not.toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
  });
});

describe("FiltersPanel — pre-set form values", () => {
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

  it("uses pre-set path filter value from form state", () => {
    render(
      <ConnectorSchemaProvider
        pluginId="test"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={PATH_ONLY_SCHEMA}
      >
        <ValueSetter fieldKey="pathFilters" value={"src/**\nlib/**"} />
        <FiltersPanel />
      </ConnectorSchemaProvider>,
    );
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("src/**\nlib/**");
  });
});
