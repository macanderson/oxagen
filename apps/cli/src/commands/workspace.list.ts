import { Command } from "commander";

export const workspaceListCommand = new Command("list")
  .description("List workspaces in current organization")
  .action(() => {
    // TODO: Fetch from API
    console.log("Workspaces:");
    console.log("  - default (current)");
  });
