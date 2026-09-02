import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SmtpTransportConfig } from "./types";

// Mock nodemailer so the driver is exercised without a network or credentials.
// `nodemailer` is a default (CJS interop) import in the module under test, so
// the mock exposes `default.createTransport`.
const sendMailMock = vi.fn();
const createTransportMock = vi.fn((..._args: unknown[]) => ({
  sendMail: sendMailMock,
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (...args: unknown[]): unknown =>
      createTransportMock(...args),
  },
}));

import { createSmtpTransport } from "./smtp-transport";

function cfg(over: Partial<SmtpTransportConfig> = {}): SmtpTransportConfig {
  return {
    host: "smtp.resend.com",
    port: 587,
    user: "resend",
    pass: "re_secret",
    fromEmail: "noreply@notifications.oxagen.sh",
    fromName: "Oxagen (DO NOT REPLY)",
    ...over,
  };
}

describe("createSmtpTransport", () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    createTransportMock.mockClear();
  });

  it("reports the driver name", () => {
    expect(createSmtpTransport(cfg()).driver).toBe("smtp");
  });

  it("negotiates STARTTLS on port 587 (secure:false, requireTLS:true)", () => {
    createSmtpTransport(cfg({ port: 587 }));
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.resend.com",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: "resend", pass: "re_secret" },
      }),
    );
  });

  it("uses implicit TLS on port 465 (secure:true, requireTLS:false)", () => {
    createSmtpTransport(cfg({ port: 465 }));
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, requireTLS: false }),
    );
  });

  it("honors an explicit `secure` override regardless of port", () => {
    createSmtpTransport(cfg({ port: 587, secure: true }));
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: true, requireTLS: false }),
    );
  });

  it("sends with the structured default From and returns accepted/rejected", async () => {
    sendMailMock.mockResolvedValue({
      messageId: "<id@x>",
      accepted: ["a@x.com"],
      rejected: [],
    });

    const result = await createSmtpTransport(cfg()).send({
      to: "a@x.com",
      subject: "Hi",
      text: "yo",
    });

    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: {
          name: "Oxagen (DO NOT REPLY)",
          address: "noreply@notifications.oxagen.sh",
        },
        to: "a@x.com",
        subject: "Hi",
        text: "yo",
      }),
    );
    expect(result).toEqual({
      id: "<id@x>",
      accepted: ["a@x.com"],
      rejected: [],
    });
  });

  it("uses a bare address as From when no display name is configured", async () => {
    sendMailMock.mockResolvedValue({
      messageId: "<id>",
      accepted: [],
      rejected: [],
    });
    await createSmtpTransport(cfg({ fromName: undefined })).send({
      to: "a@x.com",
      subject: "s",
      text: "t",
    });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "noreply@notifications.oxagen.sh" }),
    );
  });

  it("honors an explicit `from` override and passes html/cc/bcc/replyTo through", async () => {
    sendMailMock.mockResolvedValue({
      messageId: "<id>",
      accepted: [],
      rejected: [],
    });
    await createSmtpTransport(cfg()).send({
      to: "a@x.com",
      subject: "s",
      html: "<p>h</p>",
      from: "x@y.com",
      cc: "c@x.com",
      bcc: ["d@x.com"],
      replyTo: "r@x.com",
    });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "x@y.com",
        html: "<p>h</p>",
        cc: "c@x.com",
        bcc: ["d@x.com"],
        replyTo: "r@x.com",
      }),
    );
  });

  it("normalizes Address-object accepted/rejected entries to plain strings", async () => {
    sendMailMock.mockResolvedValue({
      messageId: "<id>",
      accepted: [{ address: "a@x.com", name: "" }],
      rejected: [{ address: "b@x.com", name: "" }],
    });

    const result = await createSmtpTransport(cfg()).send({
      to: ["a@x.com", "b@x.com"],
      subject: "s",
      text: "t",
    });

    expect(result.accepted).toEqual(["a@x.com"]);
    expect(result.rejected).toEqual(["b@x.com"]);
  });

  it("propagates a transport failure to the caller", async () => {
    sendMailMock.mockRejectedValue(new Error("SMTP 535 authentication failed"));
    await expect(
      createSmtpTransport(cfg()).send({
        to: "a@x.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow("SMTP 535");
  });
});
