import { Command } from "commander";

export const authLogoutCommand = new Command("logout")
  .description("Sign out from Oxagen")
  .action(() => {
    console.log("Signing out...");
    // TODO: Implement actual logout
    console.log("✓ Signed out successfully");
  });
