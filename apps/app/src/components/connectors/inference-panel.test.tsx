// @vitest-environment jsdom
/**
 * inference-panel.test.tsx — Unit tests for InferencePanel.
 */

import { render, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { ConnectorSchemaProvider, useConnectorSchema } from "./connector-schema-provider";
import { InferencePanel } from "./inference-panel";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

afterEach(cleanup);

const FULL_INFERENCE_SCHEMA: ConnectorPluginSchema = {
  apiVersion: "oxagen.ai/v1alpha1",
  kind: "ConnectorPlugin",
  metadata: {
    id: "test",
    displayName: "Test",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
  inference: {
    enabled: true,
    defaultEnabled: true,
    toggleLabel: "Enable AI relationship inference",
    perRecordType: {
      pull_request: true,
      issue: true,
      commit: false,
    },
    confidenceThreshold: {
      defaultValue: 0.75,
      min: 0.5,
      max: 0.99,
    },
    ontologyPrompt: "Infer product features from GitHub entities.",
  },
};

const DISABLED_INFERENCE_SCHEMA: ConnectorPluginSchema = {
  ...FULL_INFERENCE_SCHEMA,
  inference: {
    enabled: false,
    defaultEnabled: false,
  },
};

const NO_INFERENCE_SCHEMA: ConnectorPluginSchema = {
  ...FULL_INFERENCE_SCHEMA,
  inference: undefined,
};

function renderPanel(schema: ConnectorPluginSchema) {
  return render(
    <ConnectorSchemaProvider
      pluginId="test"
      orgSlug="acme"
      workspaceSlug="main"
      initialSchema={schema}
    >
      <InferencePanel />
    </ConnectorSchemaProvider>,
  );
}

describe("InferencePanel — no inference", () => {
  it("renders nothing when inference not defined", () => {
    const { container } = renderPanel(NO_INFERENCE_SCHEMA);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when inference.enabled=false", () => {
    const { container } = renderPanel(DISABLED_INFERENCE_SCHEMA);
    expect(container.firstChild).toBeNull();
  });
});

describe("InferencePanel — render", () => {
  it("renders at least one toggle switch", () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThan(0);
  });

  it("renders the toggle label", () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    expect(screen.getByText("Enable AI relationship inference")).toBeInTheDocument();
  });

  it("renders confidence threshold label when enabled by default", () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    expect(screen.getByText("Confidence threshold")).toBeInTheDocument();
  });

  it("renders per-record-type section when perRecordType defined", () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    expect(screen.getByText("Infer from record types")).toBeInTheDocument();
  });

  it("renders per-record-type switches (3 types + main = 4+)", () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    const switches = screen.getAllByRole("switch");
    // 1 main + 3 per-record-type = 4 switches
    expect(switches.length).toBeGreaterThanOrEqual(4);
  });

  it("renders the ontology prompt textarea", () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    expect(screen.getByText(/Ontology extraction prompt/i)).toBeInTheDocument();
  });

  it("populates ontology prompt with schema default", () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("Infer product features from GitHub entities.");
  });
});

describe("InferencePanel — toggle", () => {
  it("hides confidence/prompt/per-type sections when main toggle is turned off", async () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    const mainSwitch = screen.getAllByRole("switch")[0];
    if (!mainSwitch) throw new Error("No switch found");
    // Toggle off
    await userEvent.click(mainSwitch);
    // Confidence section label should disappear
    expect(screen.queryByText("Confidence threshold")).not.toBeInTheDocument();
    expect(screen.queryByText(/Ontology extraction prompt/i)).not.toBeInTheDocument();
  });

  it("shows sections again when main toggle is turned back on", async () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    const mainSwitch = screen.getAllByRole("switch")[0];
    if (!mainSwitch) throw new Error("No switch found");
    // Toggle off then on
    await userEvent.click(mainSwitch);
    await userEvent.click(mainSwitch);
    expect(screen.getByText("Confidence threshold")).toBeInTheDocument();
  });
});

describe("InferencePanel — per-record-type", () => {
  it("renders enabled record types as checked", () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    const pullRequestSwitch = screen.getByRole("switch", { name: /pull request/i });
    expect(pullRequestSwitch).toHaveAttribute("aria-checked", "true");
  });

  it("renders disabled record types as unchecked", () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    const commitSwitch = screen.getByRole("switch", { name: /commit/i });
    expect(commitSwitch).toHaveAttribute("aria-checked", "false");
  });

  it("toggles per-record-type switch when clicked", async () => {
    renderPanel(FULL_INFERENCE_SCHEMA);
    const commitSwitch = screen.getByRole("switch", { name: /commit/i });
    expect(commitSwitch).toHaveAttribute("aria-checked", "false");
    await userEvent.click(commitSwitch);
    expect(commitSwitch).toHaveAttribute("aria-checked", "true");
  });
});

describe("InferencePanel — with pre-set form values", () => {
  // Tests that cover the "true" branches of form value ternaries

  function PanelWithValues({
    schema,
    values,
  }: {
    schema: ConnectorPluginSchema;
    values: Record<string, unknown>;
  }) {
    return (
      <ConnectorSchemaProvider
        pluginId="test"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={schema}
      >
        <ValueSetter values={values} />
        <InferencePanel />
      </ConnectorSchemaProvider>
    );
  }

  function ValueSetter({ values }: { values: Record<string, unknown> }) {
    const ctx = useConnectorSchema();
    React.useEffect(() => {
      for (const [k, v] of Object.entries(values)) {
        ctx.setFieldValue(k, v);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  it("uses pre-set confidence value from form state", () => {
    render(
      <PanelWithValues
        schema={FULL_INFERENCE_SCHEMA}
        values={{ inferenceConfidence: 0.9 }}
      />,
    );
    // Should display the pre-set value
    expect(screen.getByText("0.90")).toBeInTheDocument();
  });

  it("uses pre-set ontology prompt from form state", () => {
    render(
      <PanelWithValues
        schema={FULL_INFERENCE_SCHEMA}
        values={{ inferenceOntologyPrompt: "Custom prompt text" }}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("Custom prompt text");
  });

  it("uses pre-set per-record-type values from form state", () => {
    render(
      <PanelWithValues
        schema={FULL_INFERENCE_SCHEMA}
        values={{
          inferenceRecordTypes: { pull_request: false, issue: false, commit: true },
        }}
      />,
    );
    // commit should now be checked
    const commitSwitch = screen.getByRole("switch", { name: /commit/i });
    expect(commitSwitch).toHaveAttribute("aria-checked", "true");
  });
});

describe("InferencePanel — partial perRecordType override", () => {
  // Covers line 114: the `defaultOn` fallback when perRecordTypes[rtId] is undefined

  function PanelWithPartialValues() {
    return (
      <ConnectorSchemaProvider
        pluginId="test"
        orgSlug="acme"
        workspaceSlug="main"
        initialSchema={FULL_INFERENCE_SCHEMA}
      >
        <PartialSetter />
        <InferencePanel />
      </ConnectorSchemaProvider>
    );
  }

  function PartialSetter() {
    const ctx = useConnectorSchema();
    React.useEffect(() => {
      // Only set pull_request — issue and commit will use defaultOn fallback
      ctx.setFieldValue("inferenceRecordTypes", { pull_request: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  it("uses schema defaultOn for unset per-record-type keys", () => {
    render(<PanelWithPartialValues />);
    // issue defaults to true per schema, so its switch should be aria-checked=true
    const issueSwitch = screen.getByRole("switch", { name: /issue/i });
    expect(issueSwitch).toHaveAttribute("aria-checked", "true");
    // pull_request was set to false, so it should be aria-checked=false
    const prSwitch = screen.getByRole("switch", { name: /pull request/i });
    expect(prSwitch).toHaveAttribute("aria-checked", "false");
  });
});

describe("InferencePanel — schema without perRecordType", () => {
  it("renders without per-record-type section when not defined", () => {
    const schema: ConnectorPluginSchema = {
      ...FULL_INFERENCE_SCHEMA,
      inference: {
        enabled: true,
        defaultEnabled: true,
        confidenceThreshold: { defaultValue: 0.75, min: 0.5, max: 0.99 },
      },
    };
    renderPanel(schema);
    expect(screen.queryByText("Infer from record types")).not.toBeInTheDocument();
  });

  it("renders without confidence slider when not defined", () => {
    const schema: ConnectorPluginSchema = {
      ...FULL_INFERENCE_SCHEMA,
      inference: {
        enabled: true,
        defaultEnabled: true,
        toggleLabel: "Enable",
      },
    };
    renderPanel(schema);
    expect(screen.queryByText("Confidence threshold")).not.toBeInTheDocument();
  });
});
