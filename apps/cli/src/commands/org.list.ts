import { Command } from "commander";

export const orgListCommand = new Command("list")
  .description("List organizations")
  .action(() => {
    // TODO: Fetch from API
    console.log("Organizations:");
    console.log("  - example-org (current)");
  });
