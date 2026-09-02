import { z } from "zod";
import {
  registerConnector,
  type AuthCredential,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RawRecord,
  type RecordTypeSample,
} from "../types";

const connectionConfigSchema = z.object({
  instanceUrl: z.string().url(),
  objectTypes: z
    .array(z.string())
    .default(["Opportunity", "Contact", "Account", "Lead", "Case"]),
  syncDepthDays: z.number().int().positive().default(180),
});

type Config = typeof connectionConfigSchema;

// Salesforce REST API version for the query endpoint.
const SF_API_VERSION = "v59.0";

function salesforceToken(auth: AuthCredential): string | null {
  if (auth.scheme === "bearer_token") return auth.token;
  if (auth.scheme === "api_key") return auth.apiKey;
  return null;
}

/** Convert a stored SystemModstamp cursor to a SOQL-safe datetime literal. */
function soqlDateLiteral(cursor: string): string | null {
  const d = new Date(cursor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const salesforce: ConnectorDefinition<Config> = {
  connectorId: "salesforce",
  displayName: "Salesforce",
  description:
    "Sync opportunities, contacts, accounts, leads, and cases from Salesforce.",
  icon: "salesforce",
  supportedAuthSchemes: [
    "oauth2_authorization_code",
    "oauth2_client_credentials",
  ],
  deliveryMethod: "rest_polling",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("salesforce.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);
    const sfType =
      asString(asRecord(r["attributes"])["type"]) ?? sourceRecordType;

    switch (sfType.toLowerCase()) {
      case "opportunity": {
        return {
          externalId: asString(r["Id"]) ?? "",
          displayName: asString(r["Name"]),
          properties: {
            name: asString(r["Name"]),
            stage: asString(r["StageName"]),
            amount: r["Amount"],
            closeDate: asString(r["CloseDate"]),
            probability: r["Probability"],
            accountId: asString(r["AccountId"]),
            ownerId: asString(r["OwnerId"]),
            description: asString(r["Description"]),
            createdDate: asString(r["CreatedDate"]),
            lastModifiedDate: asString(r["LastModifiedDate"]),
          },
        };
      }

      case "contact": {
        return {
          externalId: asString(r["Id"]) ?? "",
          displayName:
            `${r["FirstName"] ?? ""} ${r["LastName"] ?? ""}`.trim() ||
            asString(r["Name"]),
          properties: {
            firstName: asString(r["FirstName"]),
            lastName: asString(r["LastName"]),
            email: asString(r["Email"]),
            phone: asString(r["Phone"]),
            title: asString(r["Title"]),
            department: asString(r["Department"]),
            accountId: asString(r["AccountId"]),
            createdDate: asString(r["CreatedDate"]),
            lastModifiedDate: asString(r["LastModifiedDate"]),
          },
        };
      }

      case "account": {
        return {
          externalId: asString(r["Id"]) ?? "",
          displayName: asString(r["Name"]),
          properties: {
            name: asString(r["Name"]),
            industry: asString(r["Industry"]),
            type: asString(r["Type"]),
            website: asString(r["Website"]),
            phone: asString(r["Phone"]),
            numberOfEmployees: r["NumberOfEmployees"],
            annualRevenue: r["AnnualRevenue"],
            billingCity: asString(r["BillingCity"]),
            billingCountry: asString(r["BillingCountry"]),
            createdDate: asString(r["CreatedDate"]),
            lastModifiedDate: asString(r["LastModifiedDate"]),
          },
        };
      }

      case "lead": {
        return {
          externalId: asString(r["Id"]) ?? "",
          displayName:
            `${r["FirstName"] ?? ""} ${r["LastName"] ?? ""}`.trim() ||
            asString(r["Name"]),
          properties: {
            firstName: asString(r["FirstName"]),
            lastName: asString(r["LastName"]),
            email: asString(r["Email"]),
            company: asString(r["Company"]),
            status: asString(r["Status"]),
            leadSource: asString(r["LeadSource"]),
            isConverted: r["IsConverted"],
            convertedDate: asString(r["ConvertedDate"]),
            createdDate: asString(r["CreatedDate"]),
            lastModifiedDate: asString(r["LastModifiedDate"]),
          },
        };
      }

      case "case": {
        return {
          externalId: asString(r["Id"]) ?? "",
          displayName: asString(r["Subject"]),
          properties: {
            subject: asString(r["Subject"]),
            description: asString(r["Description"]),
            status: asString(r["Status"]),
            priority: asString(r["Priority"]),
            origin: asString(r["Origin"]),
            accountId: asString(r["AccountId"]),
            contactId: asString(r["ContactId"]),
            createdDate: asString(r["CreatedDate"]),
            lastModifiedDate: asString(r["LastModifiedDate"]),
          },
        };
      }

      default:
        // Generic passthrough for custom Salesforce objects
        return {
          externalId: asString(r["Id"]) ?? "",
          displayName: asString(r["Name"]),
          properties: { sourceRecordType, ...r },
        };
    }
  },

  // Incremental SOQL poll. Pulls all standard fields of the object type updated
  // since the cursor (max SystemModstamp from the previous poll), ordered
  // ascending so the batch is deterministic and the cursor advances monotonically.
  async *poll(auth, config, recordType, cursor): AsyncIterable<RawRecord> {
    const token = salesforceToken(auth);
    if (!token) return;

    const object = recordType.replace(/[^A-Za-z0-9_]/g, ""); // SOQL identifier guard
    if (!object) return;

    const where = (() => {
      if (!cursor) return "";
      const literal = soqlDateLiteral(cursor);
      return literal ? `WHERE SystemModstamp > ${literal} ` : "";
    })();
    const soql = `SELECT FIELDS(STANDARD) FROM ${object} ${where}ORDER BY SystemModstamp ASC LIMIT 200`;
    const url = `${config.instanceUrl}/services/data/${SF_API_VERSION}/query/?q=${encodeURIComponent(soql)}`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(
        `salesforce.poll: query API ${resp.status} for ${object}`,
      );
    }
    const json = (await resp.json()) as {
      records?: Array<Record<string, unknown>>;
    };
    const now = new Date().toISOString();
    for (const raw of json.records ?? []) {
      const id = asString(raw["Id"]) ?? "";
      if (!id) continue;
      yield {
        sourceRecordType: recordType,
        externalId: id,
        raw,
        receivedAt: now,
      };
    }
  },

  // Cursor watermark: Salesforce SystemModstamp (falls back to LastModifiedDate).
  cursorOf(_recordType, raw): string | null {
    const r = asRecord(raw);
    return (
      asString(r["SystemModstamp"]) ?? asString(r["LastModifiedDate"]) ?? null
    );
  },
};

registerConnector(salesforce);

export { salesforce };
