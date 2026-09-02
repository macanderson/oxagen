/**
 * Unit tests for the public ebook lead-gate routes (cms.ts).
 *
 * Tests the route directly (no full app import) — it is public and has no auth
 * dependency, mirroring telemetry.usage.test.ts. The access layer (all DB I/O)
 * and @oxagen/notifications (email) are mocked at their module boundaries;
 * access.ts's own logic is covered separately in lib/cms/access.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  captureLead: vi.fn(),
  captureLeadAndIssueCode: vi.fn(),
  findLeadByEmail: vi.fn(),
  issueCodeForLead: vi.fn(),
  redeemAndRotate: vi.fn(),
  sendEmail: vi.fn().mockResolvedValue({ ok: true }),
  isEmailTransportConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock("../../lib/cms/access", () => ({
  captureLead: mocks.captureLead,
  captureLeadAndIssueCode: mocks.captureLeadAndIssueCode,
  findLeadByEmail: mocks.findLeadByEmail,
  issueCodeForLead: mocks.issueCodeForLead,
  redeemAndRotate: mocks.redeemAndRotate,
}));

vi.mock("@oxagen/notifications", () => ({
  sendEmail: mocks.sendEmail,
  isEmailTransportConfigured: mocks.isEmailTransportConfigured,
  bookAccessEmailTemplate: () => ({
    subject: "s",
    text: "t",
    html: "<p>h</p>",
  }),
}));

// Constants only — avoids importing the DB client barrel in a unit test.
vi.mock("@oxagen/database", () => ({
  COMPANY_SIZES: [
    "1-10",
    "11-50",
    "51-200",
    "201-500",
    "501-1000",
    "1001-5000",
    "5001-10000",
    "10001+",
  ],
  REFERRAL_SOURCES: [
    "search_engine",
    "social_media",
    "referral",
    "email",
    "blog_or_content",
    "event_or_conference",
    "advertisement",
    "word_of_mouth",
    "other",
  ],
  EDITION_SLUGS: ["field-manual", "page-flip-reader"],
  DEFAULT_EDITION_SLUG: "page-flip-reader",
}));

import { cmsRoute } from "./cms";

const SENT = "The link to the book has been sent to your email.";
const DEMO_SENT = "Thanks — we got it. We'll be in touch shortly.";
const NOT_FOUND =
  "We couldn’t find that email. Please fill out the form to get the book.";

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

async function post(path: string, body: unknown): Promise<Response> {
  return cmsRoute.request(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": freshIp(),
        "user-agent": "vitest",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const VALID_LEAD = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "Ada@Example.com",
  company: "Analytical Engines",
  companySize: "11-50",
  referralSource: "search_engine",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendEmail.mockResolvedValue({ ok: true });
  mocks.isEmailTransportConfigured.mockReturnValue(true);
  mocks.captureLeadAndIssueCode.mockResolvedValue({
    readUrl: "http://localhost:8080/read?e=page-flip-reader&c=abc",
    leadId: "lead_1",
  });
});

describe("POST /v1/cms/leads", () => {
  it("captures a valid lead, emails the link, returns the sent message", async () => {
    const res = await post("/leads", VALID_LEAD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: SENT });
    expect(mocks.captureLeadAndIssueCode).toHaveBeenCalledTimes(1);
    // email lowercased + default edition applied
    const [, edition, reason] = mocks.captureLeadAndIssueCode.mock.calls[0]!;
    expect(edition).toBe("page-flip-reader");
    expect(reason).toBe("signup");
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing required field with 400 and no side effects", async () => {
    const res = await post("/leads", { firstName: "Ada", email: "a@b.com" });
    expect(res.status).toBe(400);
    expect(mocks.captureLeadAndIssueCode).not.toHaveBeenCalled();
  });

  it("rejects an invalid companySize enum", async () => {
    const res = await post("/leads", { ...VALID_LEAD, companySize: "many" });
    expect(res.status).toBe(400);
  });

  it("honeypot: a filled website field is silently dropped (no capture, still 200)", async () => {
    const res = await post("/leads", {
      ...VALID_LEAD,
      website: "http://spam.example",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: SENT });
    expect(mocks.captureLeadAndIssueCode).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("honours a chosen edition", async () => {
    await post("/leads", { ...VALID_LEAD, edition: "field-manual" });
    expect(mocks.captureLeadAndIssueCode.mock.calls[0]![1]).toBe(
      "field-manual",
    );
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await post("/leads", "{not json");
    expect(res.status).toBe(400);
  });

  it("returns 500 when capture throws", async () => {
    mocks.captureLeadAndIssueCode.mockRejectedValueOnce(new Error("db down"));
    const res = await post("/leads", VALID_LEAD);
    expect(res.status).toBe(500);
  });

  it("does not throw when the email transport is unconfigured (dev)", async () => {
    mocks.isEmailTransportConfigured.mockReturnValue(false);
    const res = await post("/leads", VALID_LEAD);
    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("intent:demo captures the lead only — no book code, no book email", async () => {
    mocks.captureLead.mockResolvedValue({
      id: "lead_2",
      email: "ada@example.com",
    });
    const res = await post("/leads", {
      ...VALID_LEAD,
      intent: "demo",
      jobTitle: "CTO",
      message: "We run 40 agents against a Rails monolith.",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: DEMO_SENT });
    expect(mocks.captureLead).toHaveBeenCalledTimes(1);
    const [input] = mocks.captureLead.mock.calls[0]!;
    expect(input.message).toBe("We run 40 agents against a Rails monolith.");
    expect(input.jobTitle).toBe("CTO");
    expect(input.source).toBe("demo");
    expect(mocks.captureLeadAndIssueCode).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("intent:demo honeypot echoes the demo success copy without capturing", async () => {
    const res = await post("/leads", {
      ...VALID_LEAD,
      intent: "demo",
      website: "http://spam.example",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: DEMO_SENT });
    expect(mocks.captureLead).not.toHaveBeenCalled();
    expect(mocks.captureLeadAndIssueCode).not.toHaveBeenCalled();
  });

  it("intent:demo returns 500 when capture throws", async () => {
    mocks.captureLead.mockRejectedValueOnce(new Error("db down"));
    const res = await post("/leads", { ...VALID_LEAD, intent: "demo" });
    expect(res.status).toBe(500);
  });

  it("rejects an unknown intent", async () => {
    const res = await post("/leads", { ...VALID_LEAD, intent: "newsletter" });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/cms/book/redeem", () => {
  it("returns the access result on a valid code", async () => {
    mocks.redeemAndRotate.mockResolvedValue({
      ok: true,
      html: "<html>book</html>",
      newCode: "rotated",
      editions: [
        { slug: "page-flip-reader", title: "Reader", format: "page-flip" },
      ],
      leadEmail: "ada@example.com",
    });
    const res = await post("/book/redeem", {
      edition: "page-flip-reader",
      code: "abc",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.newCode).toBe("rotated");
    expect(body.html).toContain("book");
  });

  it("passes a consumed/invalid reason straight through", async () => {
    mocks.redeemAndRotate.mockResolvedValue({ ok: false, reason: "consumed" });
    const res = await post("/book/redeem", {
      edition: "page-flip-reader",
      code: "used",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "consumed" });
  });

  it("rejects a missing code with 400", async () => {
    const res = await post("/book/redeem", { edition: "page-flip-reader" });
    expect(res.status).toBe(400);
    expect(mocks.redeemAndRotate).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with 400 before touching the access layer", async () => {
    const res = await post("/book/redeem", "{not json");
    expect(res.status).toBe(400);
    expect(mocks.redeemAndRotate).not.toHaveBeenCalled();
  });

  it("maps an access-layer failure to a 500 without leaking the error", async () => {
    mocks.redeemAndRotate.mockRejectedValue(
      new Error("neo4j down at 10.0.0.1"),
    );
    const res = await post("/book/redeem", {
      edition: "page-flip-reader",
      code: "abc",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).not.toContain("10.0.0.1");
  });
});

describe("POST /v1/cms/book/resend", () => {
  it("emails a fresh code to a known lead", async () => {
    mocks.findLeadByEmail.mockResolvedValue({
      id: "lead_1",
      email: "ada@example.com",
    });
    mocks.issueCodeForLead.mockResolvedValue(
      "http://localhost:8080/read?e=page-flip-reader&c=xyz",
    );
    const res = await post("/book/resend", { email: "ada@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true, message: SENT });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("tells an unknown email to fill out the form (no email sent)", async () => {
    mocks.findLeadByEmail.mockResolvedValue(null);
    const res = await post("/book/resend", { email: "ghost@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      sent: false,
      message: NOT_FOUND,
    });
    expect(mocks.issueCodeForLead).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid email with 400", async () => {
    const res = await post("/book/resend", { email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body with 400 before any lookup", async () => {
    const res = await post("/book/resend", "{not json");
    expect(res.status).toBe(400);
    expect(mocks.findLeadByEmail).not.toHaveBeenCalled();
  });

  it("maps a lookup failure to a 500 without leaking the error", async () => {
    mocks.findLeadByEmail.mockRejectedValue(
      new Error("postgres down at 10.0.0.2"),
    );
    const res = await post("/book/resend", { email: "ada@example.com" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).not.toContain("10.0.0.2");
  });
});
