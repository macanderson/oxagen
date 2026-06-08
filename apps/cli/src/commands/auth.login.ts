import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { writeConfig } from "../lib/config.js";

interface LoginResponse {
  token?: string;
  session?: { token?: string };
  user?: { email?: string; name?: string };
}

export const authLoginCommand = new Command("login")
  .description("Authenticate with Oxagen")
  .option("-e, --email <email>", "Email address")
  .option("-p, --password <password>", "Password")
  .action(async (options: { email?: string; password?: string }) => {
    if (!options.email || !options.password) {
      console.error("Error: email and password are required");
      process.exit(1);
    }
    console.log(`Authenticating as ${options.email}...`);
    try {
      const data = await apiRequest<LoginResponse>("/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email: options.email, password: options.password }),
      });
      const token = data.token ?? data.session?.token;
      if (!token) throw new Error("No token in response");
      writeConfig({ token });
      console.log("✓ Authenticated successfully");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
