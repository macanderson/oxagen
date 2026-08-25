// @vitest-environment jsdom
/**
 * json-code-field.test.tsx — a `code` field declaring `format: json` stores the
 * PARSED value, not the text.
 *
 * The regression this pins: the code widget stored raw text for every field,
 * so custom-webhook's `recordTypes` and custom-sql's `queries` — both
 * `z.array(...)` in their connectors' connection schemas — could never be
 * satisfied from the wizard. Neither connector could be configured at all, and
 * connection.preview then died inside the connector on
 * `config.recordTypes.map is not a function`.
 *
 * google-bigquery's `query` is SQL on the same widget and declares no format,
 * so it must keep storing a string — that half is pinned here too.
 */
import { render, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";

import { FieldRenderer } from "./field-renderer";
import {
  ConnectorSchemaProvider,
  useConnectorSchema,
} from "./connector-schema-provider";
import type { SchemaField } from "./field-renderer-types";

/**
 * Renders the STORED form value and its runtime type. The textarea's own text
 * is the same before and after this fix — the typed characters — so only the
 * stored value can tell the two apart.
 */
function StoredValueProbe({ fieldKey }: { fieldKey: string }) {
  const { formState } = useConnectorSchema();
  const v = formState.values[fieldKey];
  return (
    <>
      <span data-testid="stored-type">
        {Array.isArray(v) ? "array" : v === undefined ? "undefined" : typeof v}
      </span>
      <span data-testid="stored-json">{JSON.stringify(v) ?? "undefined"}</span>
    </>
  );
}

afterEach(cleanup);

const jsonField: SchemaField = {
  key: "recordTypes",
  label: "Record Type Definitions",
  widget: "code",
  format: "json",
};

const sqlField: SchemaField = {
  key: "query",
  label: "SQL Query",
  widget: "code",
};

function renderField(field: SchemaField) {
  return render(
    <ConnectorSchemaProvider
      pluginId="custom-webhook"
      orgSlug="acme"
      workspaceSlug="main"
      initialSchema={
        {
          pluginId: "custom-webhook",
          config: { fields: [field] },
        } as never
      }
    >
      <FieldRenderer field={field} />
      <StoredValueProbe fieldKey={field.key} />
    </ConnectorSchemaProvider>,
  );
}

describe("code field with format: json", () => {
  it("stores the parsed value, not the typed text", async () => {
    const user = userEvent.setup();
    renderField(jsonField);
    const box = screen.getByLabelText(/Record Type Definitions/i);

    await user.click(box);
    await user.paste('[{"sourceRecordType":"order.created","matcher":"order.created"}]');

    // What the FORM holds is an array — the shape the connector's
    // z.array(...) declares. Before this fix it held the raw string.
    expect(screen.getByTestId("stored-type")).toHaveTextContent("array");
    expect(JSON.parse(screen.getByTestId("stored-json").textContent!)).toEqual([
      { sourceRecordType: "order.created", matcher: "order.created" },
    ]);
  });

  it("surfaces a parse error while the draft is not valid JSON", async () => {
    const user = userEvent.setup();
    renderField(jsonField);
    const box = screen.getByLabelText(/Record Type Definitions/i);

    await user.click(box);
    await user.paste('[{"sourceRecordType":');

    expect(await screen.findByRole("status")).toBeInTheDocument();
    // The half-typed text survives — parsing must not delete what is being typed.
    expect((box as HTMLTextAreaElement).value).toBe('[{"sourceRecordType":');
    // ...and the form holds nothing, so an unparseable draft can never be
    // submitted as a stale earlier parse the textarea no longer shows.
    expect(screen.getByTestId("stored-type")).toHaveTextContent("undefined");
  });

  it("a code field without a format keeps storing text (SQL)", async () => {
    const user = userEvent.setup();
    renderField(sqlField);
    const box = screen.getByLabelText(/SQL Query/i);

    await user.click(box);
    await user.paste("SELECT * FROM t WHERE updated_at > @cursor");

    // Stored as a STRING: SQL on the same widget must not be parsed.
    expect(screen.getByTestId("stored-type")).toHaveTextContent("string");
    expect(JSON.parse(screen.getByTestId("stored-json").textContent!)).toBe(
      "SELECT * FROM t WHERE updated_at > @cursor",
    );
    // No JSON parse error: this widget is not a JSON field.
    expect(screen.queryByRole("status")).toBeNull();
  });
});
