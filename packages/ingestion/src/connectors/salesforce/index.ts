import { z } from "zod";
import { registerConnector, type ConnectorDefinition, type NormalizedRecord, type RecordTypeSample } from "../types";

const connectionConfigSchema = z.object({
  instanceUrl: z.string().url(),
  objectTypes: z.array(z.string()).default(["Opportunity", "Contact", "Account", "Lead", "Case"]),
  syncDepthDays: z.number().int().positive().default(180),
});

type Config = typeof connectionConfigSchema;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const salesforce: ConnectorDefinition<Config> = {
  connectorId: "salesforce",
  displayName: "Salesforce",
  description: "Sync opportunities, contacts, accounts, leads, and cases from Salesforce.",
  icon: "salesforce",
  supportedAuthSchemes: ["oauth2_authorization_code", "oauth2_client_credentials"],
  deliveryMethod: "rest_polling",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("salesforce.previewRecordTypes: not yet implemented");
  },

  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);
    const sfType = asString(asRecord(r["attributes"])["type"]) ?? sourceRecordType;

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
          displayName: `${r["FirstName"] ?? ""} ${r["LastName"] ?? ""}`.trim() || asString(r["Name"]),
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
          displayName: `${r["FirstName"] ?? ""} ${r["LastName"] ?? ""}`.trim() || asString(r["Name"]),
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

  async *poll(_auth, _config, _recordType, _cursor) {
    throw new Error("salesforce.poll: not yet implemented");
  },
};

registerConnector(salesforce);

export { salesforce };
