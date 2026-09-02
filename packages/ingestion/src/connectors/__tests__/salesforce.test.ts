import { describe, it, expect } from "vitest";
import { salesforce } from "../salesforce/index";

describe("salesforce connector – normalizeRecord", () => {
  describe("opportunity", () => {
    it("maps a realistic opportunity payload", () => {
      const raw = {
        Id: "0065g00000AbcXYZ",
        Name: "ACME Corp — Enterprise Deal",
        StageName: "Negotiation",
        Amount: 150000,
        CloseDate: "2024-03-31",
        Probability: 75,
        AccountId: "001abc",
        OwnerId: "005xyz",
        Description: "Enterprise license deal",
        CreatedDate: "2024-01-15T09:00:00Z",
        LastModifiedDate: "2024-02-01T12:00:00Z",
        attributes: { type: "Opportunity" },
      };
      const result = salesforce.normalizeRecord("opportunity", raw);
      expect(result.externalId).toBe("0065g00000AbcXYZ");
      expect(result.displayName).toBe("ACME Corp — Enterprise Deal");
      expect(result.properties["stage"]).toBe("Negotiation");
      expect(result.properties["amount"]).toBe(150000);
      expect(result.properties["probability"]).toBe(75);
    });

    it("handles empty opportunity gracefully", () => {
      const result = salesforce.normalizeRecord("opportunity", {
        attributes: { type: "Opportunity" },
      });
      expect(result.externalId).toBe("");
    });
  });

  describe("contact", () => {
    it("maps a contact payload", () => {
      const raw = {
        Id: "003abc",
        FirstName: "Alice",
        LastName: "Smith",
        Email: "alice@acme.com",
        Phone: "+1-555-1234",
        Title: "VP Engineering",
        Department: "Engineering",
        AccountId: "001abc",
        CreatedDate: "2023-06-01T00:00:00Z",
        LastModifiedDate: "2024-01-01T00:00:00Z",
        attributes: { type: "Contact" },
      };
      const result = salesforce.normalizeRecord("contact", raw);
      expect(result.externalId).toBe("003abc");
      expect(result.displayName).toBe("Alice Smith");
      expect(result.properties["email"]).toBe("alice@acme.com");
      expect(result.properties["title"]).toBe("VP Engineering");
    });

    it("handles empty contact gracefully", () => {
      const result = salesforce.normalizeRecord("contact", {
        attributes: { type: "Contact" },
      });
      expect(result.externalId).toBe("");
      // No FirstName/LastName/Name → displayName resolves to undefined
      expect(result.displayName).toBeUndefined();
    });
  });

  describe("account", () => {
    it("maps an account payload", () => {
      const raw = {
        Id: "001abc",
        Name: "ACME Corp",
        Industry: "Technology",
        Type: "Customer",
        Website: "https://acme.com",
        NumberOfEmployees: 500,
        AnnualRevenue: 10000000,
        BillingCity: "San Francisco",
        BillingCountry: "US",
        CreatedDate: "2020-01-01T00:00:00Z",
        LastModifiedDate: "2024-01-01T00:00:00Z",
        attributes: { type: "Account" },
      };
      const result = salesforce.normalizeRecord("account", raw);
      expect(result.externalId).toBe("001abc");
      expect(result.displayName).toBe("ACME Corp");
      expect(result.properties["industry"]).toBe("Technology");
      expect(result.properties["numberOfEmployees"]).toBe(500);
    });
  });

  describe("lead", () => {
    it("maps a lead payload", () => {
      const raw = {
        Id: "00Q123",
        FirstName: "Bob",
        LastName: "Jones",
        Email: "bob@prospect.com",
        Company: "Prospect Inc",
        Status: "Open - Not Contacted",
        LeadSource: "Web",
        IsConverted: false,
        CreatedDate: "2024-01-20T00:00:00Z",
        LastModifiedDate: "2024-01-20T00:00:00Z",
        attributes: { type: "Lead" },
      };
      const result = salesforce.normalizeRecord("lead", raw);
      expect(result.externalId).toBe("00Q123");
      expect(result.displayName).toBe("Bob Jones");
      expect(result.properties["company"]).toBe("Prospect Inc");
      expect(result.properties["isConverted"]).toBe(false);
    });
  });

  describe("sfType from attributes", () => {
    it("uses attributes.type to dispatch even when sourceRecordType differs", () => {
      const raw = {
        Id: "003abc",
        FirstName: "Charlie",
        LastName: "Brown",
        attributes: { type: "Contact" },
      };
      // Pass "contact" as sourceRecordType but attributes.type is Contact
      const result = salesforce.normalizeRecord("contact", raw);
      expect(result.externalId).toBe("003abc");
      expect(result.displayName).toBe("Charlie Brown");
    });
  });

  describe("unknown / generic passthrough", () => {
    it("passes through unknown SF object types", () => {
      const raw = {
        Id: "custom-001",
        Name: "My Custom Record",
        CustomField__c: "value",
        attributes: { type: "Custom__c" },
      };
      const result = salesforce.normalizeRecord("Custom__c", raw);
      expect(result.externalId).toBe("custom-001");
      expect(result.displayName).toBe("My Custom Record");
      expect(result.properties["CustomField__c"]).toBe("value");
    });
  });
});
