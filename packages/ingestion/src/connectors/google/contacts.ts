import { z } from "zod";
import {
  registerConnector,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RecordTypeSample,
} from "../types";

const connectionConfigSchema = z.object({
  includeOtherContacts: z.boolean().default(false),
  resourceNames: z.array(z.string()).optional(),
});

type Config = typeof connectionConfigSchema;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const googleContacts: ConnectorDefinition<Config> = {
  connectorId: "google-contacts",
  displayName: "Google Contacts",
  description: "Sync contacts and people from Google Contacts.",
  icon: "google-contacts",
  supportedAuthSchemes: ["oauth2_authorization_code"],
  deliveryMethod: "rest_polling",
  defaultPollIntervalSeconds: 3600,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("google-contacts.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);

    switch (sourceRecordType) {
      case "person": {
        const names = asArray(r["names"]);
        const emailAddresses = asArray(r["emailAddresses"]);
        const phoneNumbers = asArray(r["phoneNumbers"]);
        const organizations = asArray(r["organizations"]);

        const primaryName = asRecord(names[0]);
        const primaryEmail = asRecord(emailAddresses[0]);
        const primaryOrg = asRecord(organizations[0]);

        return {
          externalId: asString(r["resourceName"]) ?? "",
          displayName: asString(primaryName["displayName"]),
          properties: {
            displayName: asString(primaryName["displayName"]),
            givenName: asString(primaryName["givenName"]),
            familyName: asString(primaryName["familyName"]),
            email: asString(primaryEmail["value"]),
            emails: emailAddresses
              .map((e) => asString(asRecord(e)["value"]))
              .filter(Boolean),
            phoneNumbers: phoneNumbers
              .map((p) => asString(asRecord(p)["value"]))
              .filter(Boolean),
            organization: asString(primaryOrg["name"]),
            jobTitle: asString(primaryOrg["title"]),
            etag: asString(r["etag"]),
            updatedAt: asString(
              asRecord(r["metadata"])["sources"]
                ? asString(
                    asRecord(asArray(asRecord(r["metadata"])["sources"])[0])[
                      "updateTime"
                    ],
                  )
                : undefined,
            ),
          },
        };
      }

      default:
        throw new Error(
          `google-contacts.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
    }
  },
};

registerConnector(googleContacts);

export { googleContacts };
