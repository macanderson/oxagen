// @vitest-environment jsdom
/**
 * record-type-selector.test.tsx — Unit tests for RecordTypeSelector.
 */

import { render, cleanup, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import {
  ConnectorSchemaProvider,
  useConnectorSchema,
} from "./connector-schema-provider";
import { RecordTypeSelector } from "./record-type-selector";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

afterEach(cleanup);

const SCHEMA: ConnectorPluginSchema = {
  apiVersion: "oxagen.ai/v1alpha1",
  kind: "ConnectorPlugin",
  metadata: {
    id: "test",
    displayName: "Test",
    version: "1.0.0",
    schemaVersion: "1",
    publisher: { name: "Oxagen", verified: true },
  },
  recordTypes: {
    selectionMode: "multi",
    defaultAll: false,
    items: [
      {
        id: "pull_request",
        displayName: "Pull Requests",
        description: "PRs",
        defaultEnabled: true,
      },
      {
        id: "issue",
        displayName: "Issues",
        description: "Bugs",
        defaultEnabled: true,
      },
      {
        id: "release",
        displayName: "Releases",
        description: "Tags",
        defaultEnabled: false,
      },
    ],
  },
};

function renderSelector(schema = SCHEMA) {
  return render(
    <ConnectorSchemaProvider
      pluginId="test"
      orgSlug="acme"
      workspaceSlug="main"
      initialSchema={schema}
    >
      <RecordTypeSelector />
    </ConnectorSchemaProvider>,
  );
}

describe("RecordTypeSelector — render", () => {
  it("renders all record type display names", () => {
    renderSelector();
    expect(screen.getByText("Pull Requests")).toBeInTheDocument();
    expect(screen.getByText("Issues")).toBeInTheDocument();
    expect(screen.getByText("Releases")).toBeInTheDocument();
  });

  it("renders descriptions for each record type", () => {
    renderSelector();
    expect(screen.getByText("PRs")).toBeInTheDocument();
    expect(screen.getByText("Bugs")).toBeInTheDocument();
  });

  it("shows select all button when 3+ items in multi mode", () => {
    renderSelector();
    expect(screen.getByText("Select all")).toBeInTheDocument();
  });

  it("shows aria-checked=true for defaultEnabled items", () => {
    renderSelector();
    const prCheckbox = screen.getByRole("checkbox", { name: /pull requests/i });
    expect(prCheckbox).toHaveAttribute("aria-checked", "true");
  });

  it("shows aria-checked=false for non-default items", () => {
    renderSelector();
    const releaseCheckbox = screen.getByRole("checkbox", { name: /releases/i });
    expect(releaseCheckbox).toHaveAttribute("aria-checked", "false");
  });
});

describe("RecordTypeSelector — interaction", () => {
  it("toggles a record type off on click", async () => {
    renderSelector();
    const prCheckbox = screen.getByRole("checkbox", {
      name: /pull requests selected/i,
    });
    await userEvent.click(prCheckbox);
    // After click, it should be unchecked
    expect(prCheckbox).toHaveAttribute("aria-checked", "false");
  });

  it("toggles a record type on when unchecked item clicked", async () => {
    renderSelector();
    const releaseCheckbox = screen.getByRole("checkbox", {
      name: /releases not selected/i,
    });
    await userEvent.click(releaseCheckbox);
    expect(releaseCheckbox).toHaveAttribute("aria-checked", "true");
  });

  it("select all selects all items", async () => {
    renderSelector();
    await userEvent.click(screen.getByText("Select all"));
    const allCheckboxes = screen.getAllByRole("checkbox");
    for (const cb of allCheckboxes) {
      expect(cb).toHaveAttribute("aria-checked", "true");
    }
  });

  it("deselect all deselects all items when all are selected", async () => {
    renderSelector();
    // First select all
    await userEvent.click(screen.getByText("Select all"));
    // Button now says "Deselect all"
    await userEvent.click(screen.getByText("Deselect all"));
    const allCheckboxes = screen.getAllByRole("checkbox");
    for (const cb of allCheckboxes) {
      expect(cb).toHaveAttribute("aria-checked", "false");
    }
  });
});

describe("RecordTypeSelector — single selection mode", () => {
  it("does not show select all button in single mode", () => {
    const singleSchema: ConnectorPluginSchema = {
      ...SCHEMA,
      recordTypes: {
        selectionMode: "single",
        items: [
          { id: "a", displayName: "A", defaultEnabled: true },
          { id: "b", displayName: "B", defaultEnabled: false },
        ],
      },
    };
    renderSelector(singleSchema);
    expect(screen.queryByText("Select all")).not.toBeInTheDocument();
  });

  it("selecting one item deselects others in single mode", async () => {
    const singleSchema: ConnectorPluginSchema = {
      ...SCHEMA,
      recordTypes: {
        selectionMode: "single",
        items: [
          { id: "a", displayName: "A", defaultEnabled: true },
          { id: "b", displayName: "B", defaultEnabled: false },
        ],
      },
    };
    renderSelector(singleSchema);
    const bCheckbox = screen.getByRole("checkbox", { name: /b not selected/i });
    await userEvent.click(bCheckbox);
    expect(bCheckbox).toHaveAttribute("aria-checked", "true");
    const aCheckbox = screen.getByRole("checkbox", { name: /a/i });
    expect(aCheckbox).toHaveAttribute("aria-checked", "false");
  });
});

describe("RecordTypeSelector — empty schema", () => {
  it("renders nothing when no recordTypes defined", () => {
    const emptySchema: ConnectorPluginSchema = {
      ...SCHEMA,
      recordTypes: undefined,
    };
    const { container } = renderSelector(emptySchema);
    expect(container.firstChild).toBeNull();
  });
});
