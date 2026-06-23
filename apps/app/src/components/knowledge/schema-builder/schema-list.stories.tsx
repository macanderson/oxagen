import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { SchemaList } from "./schema-list";
import type { SchemaItem } from "./types";

const meta: Meta<typeof SchemaList> = {
  title: "Knowledge/SchemaBuilder/SchemaList",
  component: SchemaList,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof SchemaList>;

const SCHEMAS: SchemaItem[] = [
  {
    schemaName: "core",
    displayName: "Core",
    source: "recommended",
    enabled: true,
    labels: [
      { name: "Person", displayName: "Person" },
      { name: "Organization", displayName: "Organization" },
    ],
    relationshipTypes: [{ name: "WORKS_FOR", displayName: "Works For" }],
  },
  {
    schemaName: "github",
    displayName: "GitHub",
    source: "connector",
    connectorId: "conn_01",
    enabled: false,
    labels: [{ name: "Repository", displayName: "Repository" }],
    relationshipTypes: [{ name: "OWNS", displayName: "Owns" }],
  },
  {
    schemaName: "custom",
    displayName: "Custom",
    source: "user",
    enabled: true,
    labels: [],
    relationshipTypes: [],
  },
];

export const Default: Story = {
  render: () => (
    <SchemaList
      schemas={SCHEMAS}
      onToggle={async (schemaName, enabled) => ({
        schemaName,
        enabled,
        publishedVersionId: null,
        pinnedVersionId: null,
        isDowngrade: false,
        reconcileRecommended: false,
      })}
      onSelect={(name) => console.log("selected:", name)}
      onReconcile={(name) => console.log("reconcile:", name)}
      selectedSchemaName="core"
      isAdmin={true}
    />
  ),
};

export const ReadOnlyViewer: Story = {
  render: () => (
    <SchemaList
      schemas={SCHEMAS}
      onToggle={async (schemaName, enabled) => ({
        schemaName,
        enabled,
        publishedVersionId: null,
        pinnedVersionId: null,
        isDowngrade: false,
        reconcileRecommended: false,
      })}
      onSelect={(name) => console.log("selected:", name)}
      onReconcile={(name) => console.log("reconcile:", name)}
      selectedSchemaName={null}
      isAdmin={false}
    />
  ),
};

export const Empty: Story = {
  render: () => (
    <SchemaList
      schemas={[]}
      onToggle={async (schemaName, enabled) => ({
        schemaName,
        enabled,
        publishedVersionId: null,
        pinnedVersionId: null,
        isDowngrade: false,
        reconcileRecommended: false,
      })}
      onSelect={() => {}}
      onReconcile={() => {}}
      selectedSchemaName={null}
      isAdmin={true}
    />
  ),
};
