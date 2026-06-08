import { Command } from "commander";

export const authWhoamiCommand = new Command("whoami")
  .description("Show current user and organization")
  .action(() => {
    // TODO: Fetch from API
    console.log("User: user@example.com");
    console.log("Organization: example-org");
    console.log("Workspace: default");
  });
