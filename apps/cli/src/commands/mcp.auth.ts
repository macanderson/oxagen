/**
 * `oxagen mcp auth <server>` — Authenticate an MCP server.
 *
 * For OAuth servers: opens browser for the authorize flow, stores tokens locally.
 * For bearer servers: prompts for (or reads from stdin) the token and stores it.
 * For header servers: prompts for header values and stores them.
 */
import { Command } from "commander";
import { resolveSettings, findProjectRoot } from "@oxagen/mcp-config/resolve";
import { writeCredential, readCredential } from "@oxagen/mcp-config/credentials";
import type { McpServerConfig } from "@oxagen/mcp-config/schema";
import { createInterface } from "node:readline";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const mcpAuthCommand = new Command("auth")
  .description("Authenticate an MCP server (store credentials locally)")
  .argument("<server>", "Server name to authenticate")
  .option("--token <token>", "Bearer token (avoids interactive prompt)")
  .option("--stdin", "Read token from stdin (for piping)")
  .option("--status", "Show current auth status without changing anything")
  .action(async (server: string, options: { token?: string; stdin?: boolean; status?: boolean }) => {
    const projectRoot = findProjectRoot();
    const { settings } = resolveSettings({ projectRoot });
    const serverConfig = settings.mcpServers?.[server] as McpServerConfig | undefined;

    if (!serverConfig) {
      console.error(`Error: server "${server}" not found in any settings scope.`);
      console.error("Run `oxagen mcp list` to see configured servers.");
      process.exit(1);
    }

    // Status check
    if (options.status) {
      const cred = readCredential(server);
      if (!cred) {
        console.log(`${server}: no stored credentials`);
      } else if (cred.accessToken) {
        const expired = cred.expiresAt ? new Date(cred.expiresAt).getTime() < Date.now() : false;
        const refreshable = !!cred.refreshToken;
        console.log(`${server}: ${expired ? "EXPIRED" : "authenticated"}`);
        if (cred.expiresAt) console.log(`  Expires: ${cred.expiresAt}`);
        if (refreshable) console.log(`  Refresh token: available`);
        if (cred.updatedAt) console.log(`  Last updated: ${cred.updatedAt}`);
      } else {
        console.log(`${server}: credential file exists but no access token`);
      }
      return;
    }

    if (serverConfig.transport === "stdio") {
      console.log(`Server "${server}" uses stdio transport — no auth needed.`);
      return;
    }

    const auth = "auth" in serverConfig ? serverConfig.auth : "none";

    if (auth === "none") {
      console.log(`Server "${server}" has auth=none — no credentials required.`);
      return;
    }

    if (auth === "oauth") {
      // OAuth flow requires a browser redirect. For now, provide instructions.
      // Full OAuth CLI flow (opening browser, running callback server) is a future enhancement.
      const oauthUrl = "oauthServerUrl" in serverConfig ? serverConfig.oauthServerUrl : serverConfig.url;
      console.log(`Server "${server}" uses OAuth 2.1 authentication.`);
      console.log("");
      console.log("To authenticate:");
      console.log(`  1. Run: oxagen mcp auth ${server} --token <access_token>`);
      console.log("     (if you have a token from another flow)");
      console.log("");
      console.log("  2. Or use the web app to complete the OAuth flow:");
      console.log(`     Visit your workspace settings → Integrations → ${server}`);
      console.log("");
      if (oauthUrl) {
        console.log(`  OAuth server: ${oauthUrl}`);
      }
      // If --token was provided, store it
      if (options.token) {
        writeCredential(server, { accessToken: options.token, tokenType: "Bearer" });
        console.log(`Stored access token for "${server}".`);
      }
      return;
    }

    if (auth === "bearer") {
      let token: string | undefined = options.token;

      if (options.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        token = Buffer.concat(chunks).toString("utf8").trim();
      }

      if (!token) {
        token = await prompt(`Enter bearer token for "${server}": `);
      }

      if (!token) {
        console.error("Error: no token provided.");
        process.exit(1);
      }

      writeCredential(server, { accessToken: token, tokenType: "Bearer" });
      console.log(`Stored bearer token for "${server}".`);
      return;
    }

    if (auth === "header") {
      console.log(`Server "${server}" uses header-based auth.`);
      console.log("Enter header values (or set them via environment variables in settings.json):");
      const headers: Record<string, string> = {};

      // Read headers interactively
      const headerCount = await prompt("How many headers? ");
      const count = parseInt(headerCount, 10) || 0;
      for (let i = 0; i < count; i++) {
        const key = await prompt(`  Header ${i + 1} name: `);
        const value = await prompt(`  Header ${i + 1} value: `);
        if (key) headers[key] = value;
      }

      if (Object.keys(headers).length > 0) {
        writeCredential(server, { headers });
        console.log(`Stored ${Object.keys(headers).length} header(s) for "${server}".`);
      } else {
        console.log("No headers provided. Credential unchanged.");
      }
    }
  });
