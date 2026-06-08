import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { clearConfig, getToken } from "../lib/config.js";

export const authLogoutCommand = new Command("logout")
  .description("Sign out from Oxagen")
  .action(async () => {
    console.log("Signing out...");
    const token = getToken();
    if (token) {
      try {
        await apiRequest("/auth/sign-out", { method: "POST" });
      } catch {
        // ignore — clear local config regardless
      }
    }
    clearConfig();
    console.log("✓ Signed out successfully");
  });
