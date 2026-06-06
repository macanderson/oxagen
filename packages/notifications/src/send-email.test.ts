import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the transport resolver so the facade is tested in isolation — no env,
// no nodemailer. We assert what the facade forwards after validation.
const sendMock = vi.fn();
vi.mock("./transport", () => ({
  emailTransport: (): { driver: string; send: typeof sendMock } => ({
    driver: "smtp",
    send: sendMock,
  }),
}));

import { sendEmail } from "./send-email";

describe("sendEmail", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("validates and forwards a well-formed payload to the transport", async () => {
    sendMock.mockResolvedValue({ id: "<id>", accepted: ["a@x.com"], rejected: [] });

    const result = await sendEmail({ to: "a@x.com", subject: "Welcome", text: "hi" });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@x.com", subject: "Welcome", text: "hi" }),
    );
    expect(result).toEqual({ id: "<id>", accepted: ["a@x.com"], rejected: [] });
  });

  it("accepts a list of recipients plus cc and bcc", async () => {
    sendMock.mockResolvedValue({ id: "<id>", accepted: ["a@x.com", "b@x.com"], rejected: [] });

    await sendEmail({
      to: ["a@x.com", "b@x.com"],
      cc: "c@x.com",
      bcc: ["d@x.com"],
      subject: "s",
      html: "<p>h</p>",
    });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ cc: "c@x.com", bcc: ["d@x.com"], html: "<p>h</p>" }),
    );
  });

  it("rejects a payload with neither text nor html, without calling the transport", async () => {
    // Valid TypeScript (text/html are optional) but fails the schema refine.
    await expect(sendEmail({ to: "a@x.com", subject: "s" })).rejects.toThrow(
      /at least one of/i,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid recipient address", async () => {
    await expect(sendEmail({ to: "not-an-email", subject: "s", text: "t" })).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects an empty subject", async () => {
    await expect(sendEmail({ to: "a@x.com", subject: "", text: "t" })).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects an empty recipient list", async () => {
    await expect(sendEmail({ to: [], subject: "s", text: "t" })).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  // ── Additional negative assertions ─────────────────────────────────────────

  it("rejects to:[\"not-an-email\"] (array with invalid address)", async () => {
    await expect(sendEmail({ to: ["not-an-email"], subject: "s", text: "t" })).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects replyTo:\"not-an-email\" (invalid replyTo address)", async () => {
    await expect(
      sendEmail({ to: "a@x.com", subject: "s", text: "t", replyTo: "not-an-email" }),
    ).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects html:\"\" (empty html with text present — fails min(1) on html)", async () => {
    await expect(sendEmail({ to: "a@x.com", subject: "s", text: "t", html: "" })).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects bcc:[] (empty bcc array — fails min(1) on the array union branch)", async () => {
    await expect(sendEmail({ to: "a@x.com", subject: "s", text: "t", bcc: [] })).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("accepts html:\" \" (whitespace — passes min(1) since length=1)", async () => {
    // z.string().min(1) checks .length >= 1; a single space has length 1, so
    // it passes the Zod validator. The real behaviour is documented here rather
    // than normalised away — if a future trimmed() is added this test will catch it.
    sendMock.mockResolvedValue({ id: "<id>", accepted: ["a@x.com"], rejected: [] });
    await expect(sendEmail({ to: "a@x.com", subject: "s", html: " " })).resolves.toBeDefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
