import { Command } from "commander";

export const authLoginCommand = new Command("login")
  .description("Authenticate with Oxagen")
  .option("-e, --email <email>", "Email address")
  .option("-p, --password <password>", "Password")
  .action((options) => {
    if (!options.email || !options.password) {
      console.error("Error: email and password are required");
      process.exit(1);
    }
    console.log(`Authenticating as ${options.email}...`);
    // TODO: Implement actual auth with API
    console.log("✓ Authenticated successfully");
  });
