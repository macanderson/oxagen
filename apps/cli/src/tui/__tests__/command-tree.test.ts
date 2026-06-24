import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { buildCommandTree } from "../command-tree.js";

function fixture(): Command {
  const program = new Command("oxagen").description("Oxagen developer CLI");
  const auth = program.command("auth").description("Authentication");
  auth
    .command("login")
    .description("Authenticate")
    .requiredOption("--email <email>", "Email address")
    .requiredOption("--password <password>", "Password")
    .option("--remember", "Stay signed in")
    .action(() => {});
  const agent = program.command("agent").description("Agent commands");
  const mcp = agent.command("mcp").description("MCP servers");
  mcp
    .command("register")
    .description("Register an MCP server")
    .argument("<name>", "server name")
    .option("--auth-config <json>", "auth config")
    .action(() => {});
  return program;
}

describe("buildCommandTree", () => {
  it("maps nested groups, args, options, and runnable leaves", () => {
    const tree = buildCommandTree(fixture());
    expect(tree.name).toBe("oxagen");
    expect(tree.path).toEqual([]);
    expect(tree.children.map((c) => c.name).sort()).toEqual(["agent", "auth"]);

    const authNode = tree.children.find((c) => c.name === "auth");
    expect(authNode).toBeDefined();
    const login = authNode!.children[0]!;
    expect(login.path).toEqual(["auth", "login"]);
    expect(login.runnable).toBe(true);
    expect(login.options.find((o) => o.long === "--email")!.required).toBe(true);
    expect(login.options.find((o) => o.long === "--remember")!.isBoolean).toBe(
      true
    );

    const agentNode = tree.children.find((c) => c.name === "agent");
    expect(agentNode).toBeDefined();
    const mcpNode = agentNode!.children.find((c) => c.name === "mcp");
    expect(mcpNode).toBeDefined();
    const register = mcpNode!.children[0]!;
    expect(register.path).toEqual(["agent", "mcp", "register"]);
    expect(register.args[0]!).toMatchObject({
      name: "name",
      required: true,
      variadic: false,
    });
    expect(
      register.options.find((o) => o.long === "--auth-config")!.secret
    ).toBe(true);
  });

  it("omits the implicit help command", () => {
    const tree = buildCommandTree(fixture());
    expect(tree.children.some((c) => c.name === "help")).toBe(false);
  });
});
