import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface PluginCredentialSetSecretResponse {
  ok: boolean;
}

export const pluginCredentialSetSecretCommand = new Command("set-secret")
  .description("Store or update an encrypted credential for a plugin server")
  .requiredOption("-l, --listing <id>", "Org listing ID")
  .requiredOption("-a, --auth-kind <kind>", "Auth kind: oauth or secret")
  .option("--secret <value>", "Secret value (for auth-kind=secret)")
  .option("--access-token <token>", "OAuth access token (for auth-kind=oauth)")
  .option("--refresh-token <token>", "OAuth refresh token (for auth-kind=oauth)")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { listing: string; authKind: string; secret?: string; accessToken?: string; refreshToken?: string; org?: string }) => {
    try {
      const data = await apiRequest<PluginCredentialSetSecretResponse>("/plugin/credential/set_secret", {
        method: "POST",
        body: JSON.stringify({
          orgListingId: options.listing,
          authKind: options.authKind,
          secret: options.secret,
          accessToken: options.accessToken,
          refreshToken: options.refreshToken,
          org_id: options.org ?? getOrgId(),
        }),
      });
      console.log(data.ok ? "✓ Credential stored" : "Failed to store credential");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
