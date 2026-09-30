// Add server's Local command and registry package checks (ADR-233, #4756):
// the server.toml Studio writes for a new server that runs on machines, the
// pin a local command sends, and every problem the form names before the
// save.
import { describe, expect, it } from "vitest";
import {
  argumentKey,
  newLocalServer,
  newPackageServer,
  secretVariable,
  suggestedServerName,
} from "./machine-server";

const HEX = "c3".repeat(32);

type LocalForm = Parameters<typeof newLocalServer>[0];
type PackageForm = Parameters<typeof newPackageServer>[0];

function localOf(over: Partial<LocalForm> = {}): LocalForm {
  return {
    name: "notes",
    label: "Notes",
    description: "Notes kept on each machine.",
    command: "/usr/local/bin/notes-mcp",
    arguments: "",
    variables: "",
    machines: "dev-laptops",
    version: "0.9.2",
    digest: HEX,
    ...over,
  };
}

function packageOf(over: Partial<PackageForm> = {}): PackageForm {
  return {
    name: "files",
    label: "Files",
    description: "Reads and writes files in the directory each machine sets.",
    registryRef: "io.github.modelcontextprotocol/server-filesystem",
    entryVersion: "2026.8.1",
    registryType: "npm",
    machines: "dev-laptops",
    arguments: [],
    variables: [],
    ...over,
  };
}

function problemsOf(answer: ReturnType<typeof newLocalServer>) {
  if (answer.ok) throw new Error("expected problems, got a server");
  return answer.problems;
}

function valueOf(answer: ReturnType<typeof newLocalServer>) {
  if (!answer.ok) {
    throw new Error(`expected a server, got ${JSON.stringify(answer.problems)}`);
  }
  return answer.value;
}

describe("newLocalServer", () => {
  it("writes a local source with no auth and no environments, and the pin the person named", () => {
    const value = valueOf(
      newLocalServer(
        localOf({
          arguments: "--root\n\n  /srv/notes  \n",
          variables: "NOTES_TOKEN\nNOTES_TOKEN",
          machines: "dev-laptops\nbuild-hosts\n",
        }),
      ),
    );
    expect(value.server.server).toBe("notes");
    expect(value.server.source).toBeUndefined();
    expect(value.server.serverToml).toBe(
      [
        'schema = "mcp-server/v1"',
        'name = "notes"',
        'label = "Notes"',
        'description = "Notes kept on each machine."',
        "",
        "[source]",
        'type = "local"',
        'command = "/usr/local/bin/notes-mcp"',
        'args = ["--root", "/srv/notes"]',
        'env = ["NOTES_TOKEN"]',
        'machines = ["dev-laptops", "build-hosts"]',
        "",
        "[exposure]",
        'mode = "direct"',
        "",
        "[sync]",
        'schedule = "manual"',
        "",
      ].join("\n"),
    );
    expect(value.pin).toStrictEqual({ version: "0.9.2", digest: `sha256:${HEX}` });
  });

  it.each([
    ["a bare digest", HEX],
    ["a prefixed digest", `sha256:${HEX}`],
    ["an upper-case digest", HEX.toUpperCase()],
    ["a shasum line", `${HEX}  /usr/local/bin/notes-mcp`],
  ])("reads %s as the pin's SHA-256", (_what, digest) => {
    expect(valueOf(newLocalServer(localOf({ digest }))).pin?.digest).toBe(
      `sha256:${HEX}`,
    );
  });

  it("names every problem before the save (negative)", () => {
    expect(
      problemsOf(
        newLocalServer(
          localOf({
            name: "Notes",
            label: "",
            description: "x".repeat(201),
            command: " ",
            variables: "9LIVES",
            machines: "Dev Laptops",
            version: "",
            digest: "c3c3",
          }),
        ),
      ),
    ).toStrictEqual([
      { kind: "name" },
      { kind: "label" },
      { kind: "description" },
      { kind: "command" },
      { kind: "variable", name: "9LIVES" },
      { kind: "machine", group: "Dev Laptops" },
      { kind: "version" },
      { kind: "digest" },
    ]);
  });

  it("refuses the reserved folder name and a server that runs nowhere (negative)", () => {
    expect(
      problemsOf(newLocalServer(localOf({ name: "builtin", machines: "\n" }))),
    ).toStrictEqual([{ kind: "reserved" }, { kind: "machines" }]);
  });
});

describe("newPackageServer", () => {
  it("writes a registry source on machines, and sends no pin", () => {
    const value = valueOf(
      newPackageServer(
        packageOf({
          arguments: [
            { key: "directory", value: "${WORK_DIR}", secret: false },
            { key: "--api-key", value: "", secret: true },
            { key: "--label", value: "cost $$5", secret: false },
          ],
          variables: ["FILES_HOME"],
        }),
      ),
    );
    expect(value.pin).toBeUndefined();
    expect(value.server.serverToml).toBe(
      [
        'schema = "mcp-server/v1"',
        'name = "files"',
        'label = "Files"',
        'description = "Reads and writes files in the directory each machine sets."',
        "",
        "[source]",
        'type = "registry"',
        'registry = "https://registry.modelcontextprotocol.io"',
        'server = "io.github.modelcontextprotocol/server-filesystem"',
        'version = "2026.8.1"',
        'machines = ["dev-laptops"]',
        'registry_type = "npm"',
        // The required variable, the one an argument names, and the secret's.
        'env = ["FILES_HOME", "WORK_DIR", "API_KEY"]',
        "",
        "[source.arguments]",
        '"directory" = "${WORK_DIR}"',
        '"--api-key" = "${API_KEY}"',
        '"--label" = "cost $$5"',
        "",
        "[exposure]",
        'mode = "direct"',
        "",
        "[sync]",
        'schedule = "daily"',
        "",
      ].join("\n"),
    );
  });

  it("names an empty argument, a stray $, and an entry with no version (negative)", () => {
    expect(
      problemsOf(
        newPackageServer(
          packageOf({
            entryVersion: null,
            arguments: [
              { key: "directory", value: " ", secret: false },
              { key: "--label", value: "cost $5", secret: false },
            ],
          }),
        ),
      ),
    ).toStrictEqual([
      { kind: "entryVersion" },
      { kind: "argumentRequired", argument: "directory" },
      { kind: "argumentInvalid", argument: "--label" },
    ]);
  });
});

describe("the names the package form derives", () => {
  it.each([
    ["io.github.modelcontextprotocol/server-filesystem", "server_filesystem"],
    ["app.acme/9-Notes.MCP", "notes_mcp"],
    ["io.github.acme/an-extremely-long-server-name-here", "an_extremely_long_server"],
  ])("suggests a folder name for %s", (ref, name) => {
    expect(suggestedServerName(ref)).toBe(name);
  });

  it.each([
    ["--api-key", "API_KEY"],
    ["token", "TOKEN"],
    ["2fa-code", "_2FA_CODE"],
  ])("reads the secret argument %s from %s", (key, name) => {
    expect(secretVariable(key)).toBe(name);
  });

  it("keys an argument by its name, else its hint, and skips one with neither", () => {
    const base = {
      type: "named" as const,
      isRequired: true,
      isSecret: false,
      value: null,
      default: null,
    };
    expect(argumentKey({ ...base, name: "--root", valueHint: null })).toBe("--root");
    expect(argumentKey({ ...base, name: null, valueHint: "directory" })).toBe(
      "directory",
    );
    expect(argumentKey({ ...base, name: null, valueHint: null })).toBeNull();
  });
});
