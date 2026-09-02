import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the env reader and the SMTP driver so transport resolution is tested in
// isolation: we assert the env → config mapping and the fail-closed guard.
const requireEnvMock = vi.fn();
vi.mock("@oxagen/config/env", () => ({
  requireEnv: (...args: unknown[]): unknown => requireEnvMock(...args),
}));

const createSmtpMock = vi.fn((..._args: unknown[]) => ({
  driver: "smtp",
  send: vi.fn(),
}));
vi.mock("./smtp-transport", () => ({
  createSmtpTransport: (...args: unknown[]): unknown => createSmtpMock(...args),
}));

import {
  emailTransport,
  isEmailTransportConfigured,
  __resetTransportForTests,
} from "./transport";

const FULL_ENV = {
  SMTP_HOST: "smtp.resend.com",
  SMTP_PORT: 587,
  SMTP_USERNAME: "resend",
  SMTP_PASSWORD: "re_secret",
  SMTP_FROM_EMAIL: "noreply@notifications.oxagen.sh",
  SMTP_FROM_NAME: "Oxagen (DO NOT REPLY)",
};

describe("emailTransport", () => {
  beforeEach(() => {
    requireEnvMock.mockReset();
    createSmtpMock.mockClear();
    __resetTransportForTests();
  });

  it("throws a precise error naming the missing SMTP vars", () => {
    requireEnvMock.mockReturnValue({
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_USERNAME: undefined,
      SMTP_PASSWORD: undefined,
      SMTP_FROM_EMAIL: undefined,
      SMTP_FROM_NAME: undefined,
    });
    expect(() => emailTransport()).toThrow(/missing SMTP_HOST/);
    expect(createSmtpMock).not.toHaveBeenCalled();
  });

  it("treats SMTP_FROM_NAME as optional (does not block resolution)", () => {
    requireEnvMock.mockReturnValue({ ...FULL_ENV, SMTP_FROM_NAME: undefined });
    expect(() => emailTransport()).not.toThrow();
    expect(createSmtpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fromName: undefined,
        fromEmail: "noreply@notifications.oxagen.sh",
      }),
    );
  });

  it("maps env to the SMTP config and memoizes a single instance", () => {
    requireEnvMock.mockReturnValue(FULL_ENV);

    const first = emailTransport();
    const second = emailTransport();

    expect(first).toBe(second);
    expect(createSmtpMock).toHaveBeenCalledTimes(1);
    expect(createSmtpMock).toHaveBeenCalledWith({
      host: "smtp.resend.com",
      port: 587,
      user: "resend",
      pass: "re_secret",
      fromEmail: "noreply@notifications.oxagen.sh",
      fromName: "Oxagen (DO NOT REPLY)",
    });
  });
});

describe("isEmailTransportConfigured", () => {
  beforeEach(() => {
    requireEnvMock.mockReset();
    __resetTransportForTests();
  });

  it("is true when all required SMTP vars are present", () => {
    requireEnvMock.mockReturnValue(FULL_ENV);
    expect(isEmailTransportConfigured()).toBe(true);
  });

  it("is false when a required SMTP var is missing (does not throw)", () => {
    requireEnvMock.mockReturnValue({ ...FULL_ENV, SMTP_PASSWORD: undefined });
    expect(isEmailTransportConfigured()).toBe(false);
  });

  it("ignores the optional SMTP_FROM_NAME", () => {
    requireEnvMock.mockReturnValue({ ...FULL_ENV, SMTP_FROM_NAME: undefined });
    expect(isEmailTransportConfigured()).toBe(true);
  });
});
