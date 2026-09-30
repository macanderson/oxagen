// Add server's From a definition checks (#4678, item 1): the server.toml
// Studio writes for a new server, the definition it sends, and every problem
// the form names before the save.
import { describe, expect, it } from "vitest";
import {
  definitionSchedule,
  definitionType,
  newDefinitionServer,
} from "./new-server";

const OPENAPI = '{"openapi":"3.1.0","info":{"title":"Billing","version":"1"}}';

type Form = Parameters<typeof newDefinitionServer>[0];

function formOf(over: Partial<Form> = {}): Form {
  return {
    name: "billing",
    label: "Billing",
    description: "Invoices and refunds for the billing team.",
    url: "https://billing.example.com/v1",
    type: "openapi",
    schedule: "manual",
    files: [{ name: "openapi.json", text: OPENAPI }],
    entry: "openapi.json",
    ...over,
  };
}

function built(over: Partial<Form> = {}) {
  const answer = newDefinitionServer(formOf(over));
  if (!answer.ok) {
    throw new Error(`expected a server, got ${JSON.stringify(answer.problems)}`);
  }
  return answer.server;
}

function problemsOf(over: Partial<Form>) {
  const answer = newDefinitionServer(formOf(over));
  if (answer.ok) throw new Error("expected problems, got a server");
  return answer.problems;
}

describe("newDefinitionServer", () => {
  it("writes the server.toml for an uploaded OpenAPI definition", () => {
    const server = built();
    expect(server.server).toBe("billing");
    expect(server.serverToml).toBe(
      [
        'schema = "mcp-server/v1"',
        'name = "billing"',
        'label = "Billing"',
        'description = "Invoices and refunds for the billing team."',
        "",
        "[source]",
        'type = "openapi"',
        'from = "upload"',
        "",
        "[auth]",
        'mode = "none"',
        "",
        "[environments.production]",
        'url = "https://billing.example.com/v1"',
        "",
        "[exposure]",
        'mode = "direct"',
        "",
        "[sync]",
        'schedule = "manual"',
        "",
      ].join("\n"),
    );
    expect(server.source).toStrictEqual({
      type: "openapi",
      files: [{ path: "openapi.json", text: OPENAPI }],
      entry: "openapi.json",
    });
  });

  it("keeps every OpenAPI file beside server.toml and names the root", () => {
    const server = built({
      files: [
        { name: "openapi.yaml", text: "openapi: 3.1.0\n" },
        { name: "invoices.yaml", text: "type: object\n" },
      ],
      entry: "openapi.yaml",
      schedule: "daily",
    });
    expect(server.serverToml).toContain('schedule = "daily"');
    expect(server.source).toStrictEqual({
      type: "openapi",
      files: [
        { path: "openapi.yaml", text: "openapi: 3.1.0\n" },
        { path: "invoices.yaml", text: "type: object\n" },
      ],
      entry: "openapi.yaml",
    });
  });

  it("sends a GraphQL schema as its SDL", () => {
    const sdl = "type Query { invoice(id: ID!): String }\n";
    const server = built({
      type: "graphql",
      files: [{ name: "schema.graphql", text: sdl }],
      entry: "",
    });
    expect(server.serverToml).toContain('type = "graphql"');
    expect(server.source).toStrictEqual({ type: "graphql", sdl });
  });

  it("puts gRPC files under proto/ by their file name", () => {
    const server = built({
      type: "grpc",
      files: [
        { name: "billing.proto", text: 'syntax = "proto3";\n' },
        { name: "money.proto", text: 'syntax = "proto3";\n' },
      ],
      entry: "",
    });
    expect(server.serverToml).toContain('type = "grpc"');
    expect(server.source).toStrictEqual({
      type: "grpc",
      files: [
        { path: "proto/billing.proto", text: 'syntax = "proto3";\n' },
        { path: "proto/money.proto", text: 'syntax = "proto3";\n' },
      ],
    });
  });

  it("trims each text field before it checks or writes it", () => {
    const server = built({
      name: "  billing ",
      label: " Billing  ",
      description: "\tInvoices and refunds for the billing team.\n",
      url: " https://billing.example.com/v1 ",
    });
    expect(server.server).toBe("billing");
    expect(server.serverToml).toContain('name = "billing"\n');
    expect(server.serverToml).toContain('label = "Billing"\n');
    expect(server.serverToml).toContain(
      'description = "Invoices and refunds for the billing team."\n',
    );
    expect(server.serverToml).toContain(
      'url = "https://billing.example.com/v1"\n',
    );
  });

  it("escapes quotes, backslashes, newlines and U+007F in TOML strings", () => {
    const server = built({
      label: 'The "billing" \\ API',
      description: "Line one\nLine two\u007f",
    });
    expect(server.serverToml).toContain('label = "The \\"billing\\" \\\\ API"\n');
    expect(server.serverToml).toContain(
      'description = "Line one\\nLine two\\u007F"\n',
    );
  });

  it("names every problem in the order the form shows them", () => {
    expect(
      problemsOf({
        name: "Billing!",
        label: "",
        description: "",
        url: "ftp://billing.example.com",
        files: [],
      }),
    ).toStrictEqual([
      { kind: "name" },
      { kind: "label" },
      { kind: "description" },
      { kind: "url" },
      { kind: "files" },
    ]);
  });

  it("refuses the built-in server's name", () => {
    expect(problemsOf({ name: "builtin" })).toStrictEqual([
      { kind: "reserved" },
    ]);
  });

  it.each([
    ["an upper-case letter", "Billing"],
    ["a leading digit", "1billing"],
    ["a dash", "bill-ing"],
    ["25 characters", "b".repeat(25)],
  ])("refuses a name with %s", (_, name) => {
    expect(problemsOf({ name })).toStrictEqual([{ kind: "name" }]);
  });

  it("takes a name of 24 characters with digits and underscores", () => {
    expect(built({ name: `b${"_1".repeat(11)}9` }).server).toHaveLength(24);
  });

  it("refuses a label over 80 characters and a description over 200", () => {
    expect(
      problemsOf({ label: "l".repeat(81), description: "d".repeat(201) }),
    ).toStrictEqual([{ kind: "label" }, { kind: "description" }]);
    expect(
      built({ label: "l".repeat(80), description: "d".repeat(200) }).server,
    ).toBe("billing");
  });

  it.each([
    ["a user name", "https://ops@billing.example.com/v1"],
    ["no scheme", "billing.example.com"],
    ["a scheme other than http", "ftp://billing.example.com"],
    ["no host", "https://"],
  ])("refuses a URL with %s", (_, url) => {
    expect(problemsOf({ url })).toStrictEqual([{ kind: "url" }]);
  });

  it("takes an http URL with a port and a query", () => {
    expect(
      built({ url: "http://billing.internal:8080?region=us" }).serverToml,
    ).toContain('url = "http://billing.internal:8080?region=us"\n');
  });

  it("names an unreadable file, an empty file and a repeated name", () => {
    expect(
      problemsOf({
        files: [
          { name: "openapi.json", text: OPENAPI },
          { name: "binary.json", text: null },
          { name: "blank.json", text: "  \n" },
          { name: "openapi.json", text: OPENAPI },
        ],
      }),
    ).toStrictEqual([
      { kind: "unreadable", file: "binary.json" },
      { kind: "empty", file: "blank.json" },
      { kind: "duplicate", file: "openapi.json" },
    ]);
  });

  it("names a repeated file once however often it repeats", () => {
    const file = { name: "billing.proto", text: 'syntax = "proto3";\n' };
    expect(
      problemsOf({ type: "grpc", files: [file, file, file], entry: "" }),
    ).toStrictEqual([{ kind: "duplicate", file: "billing.proto" }]);
  });

  it("asks for exactly one GraphQL file", () => {
    expect(
      problemsOf({
        type: "graphql",
        files: [
          { name: "a.graphql", text: "type Query { a: String }" },
          { name: "b.graphql", text: "type Query { b: String }" },
        ],
        entry: "",
      }),
    ).toStrictEqual([{ kind: "graphqlOne" }]);
  });

  it("asks for an OpenAPI root document among the files", () => {
    expect(problemsOf({ entry: "missing.json" })).toStrictEqual([
      { kind: "entry" },
    ]);
    expect(problemsOf({ entry: "" })).toStrictEqual([{ kind: "entry" }]);
  });

  it("ignores the root document for GraphQL and gRPC", () => {
    expect(
      built({
        type: "grpc",
        files: [{ name: "billing.proto", text: 'syntax = "proto3";\n' }],
        entry: "missing.json",
      }).source,
    ).toStrictEqual({
      type: "grpc",
      files: [{ path: "proto/billing.proto", text: 'syntax = "proto3";\n' }],
    });
  });
});

describe("definitionSchedule and definitionType", () => {
  it("read a form value and fall back when it is not one", () => {
    expect(definitionSchedule("daily")).toBe("daily");
    expect(definitionSchedule("manual")).toBe("manual");
    expect(definitionSchedule("on-change")).toBe("manual");
    expect(definitionSchedule("")).toBe("manual");
    expect(definitionType("grpc")).toBe("grpc");
    expect(definitionType("graphql")).toBe("graphql");
    expect(definitionType("soap")).toBe("openapi");
  });
});
