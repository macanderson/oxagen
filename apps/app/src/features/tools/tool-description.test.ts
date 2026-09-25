// A tool description splits into prose and worked examples, and loses no
// text on the way: the shape Notion's MCP tools publish is the fixture.
import { describe, expect, it } from "vitest";
import { splitToolDescription } from "./tool-description";

const NOTION = `Update a Notion data source's schema.
- ADD COLUMN "Name" <type> - add a new property
<example description="Add properties">{"data_source_id": "f336d0bc", "statements": "ADD COLUMN \\"Priority\\" SELECT"}</example>
<example description="Rename property">{"data_source_id": "f336d0bc", "statements": "RENAME COLUMN "Status" TO "Project Status""}</example>`;

describe("splitToolDescription", () => {
  it("pulls each example out of the prose, in order, under its title", () => {
    const { prose, examples } = splitToolDescription(NOTION);
    expect(prose).toBe(
      `Update a Notion data source's schema.\n- ADD COLUMN "Name" <type> - add a new property`,
    );
    expect(examples.map((e) => e.title)).toEqual([
      "Add properties",
      "Rename property",
    ]);
  });

  it("pretty-prints a body that parses as JSON", () => {
    const [first] = splitToolDescription(NOTION).examples;
    expect(first).toEqual({
      title: "Add properties",
      body: '{\n  "data_source_id": "f336d0bc",\n  "statements": "ADD COLUMN \\"Priority\\" SELECT"\n}',
      language: "json",
    });
  });

  it("keeps a body that does not parse as written, still coloured as JSON", () => {
    const [, second] = splitToolDescription(NOTION).examples;
    expect(second).toEqual({
      title: "Rename property",
      body: '{"data_source_id": "f336d0bc", "statements": "RENAME COLUMN "Status" TO "Project Status""}',
      language: "json",
    });
  });

  it("reads a single-quoted title, a quoted >, and a missing title", () => {
    const { examples } = splitToolDescription(
      `<example description='a > b' lang="en">x</example><example>y</example><EXAMPLE description="  ">z</EXAMPLE>`,
    );
    expect(examples).toEqual([
      { title: "a > b", body: "x", language: "text" },
      { title: null, body: "y", language: "text" },
      { title: null, body: "z", language: "text" },
    ]);
  });

  it("drops an empty examples wrapper and collapses the blank lines left behind", () => {
    const { prose, examples } = splitToolDescription(
      "Lead.\n\n<examples>\n<example>[1, 2]</example>\n</examples>\n\n  \n\nTail.",
    );
    expect(prose).toBe("Lead.\n\nTail.");
    expect(examples).toEqual([
      { title: null, body: "[\n  1,\n  2\n]", language: "json" },
    ]);
  });

  it("treats a JSON scalar as text, and leaves prose with no examples alone", () => {
    expect(splitToolDescription("<example>42</example>").examples).toEqual([
      { title: null, body: "42", language: "text" },
    ]);
    expect(splitToolDescription("  Charges a customer.  ")).toEqual({
      prose: "Charges a customer.",
      examples: [],
    });
  });

  it("leaves an unterminated example in the prose", () => {
    const { prose, examples } = splitToolDescription(
      'Text <example description="cut">{"a":',
    );
    expect(prose).toBe('Text <example description="cut">{"a":');
    expect(examples).toEqual([]);
  });
});
