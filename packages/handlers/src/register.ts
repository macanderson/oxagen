import { registerHandler, type CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

// Side-effect module: binds every foundation handler to its capability in the
// kernel as a lazy loader. Import once at app boot (api, mcp, cli) before
// dispatching. Loaders are dynamic so booting a surface does not eagerly pull
// in Stripe / Drizzle until a capability is actually invoked.

registerHandler(
  "organization.create",
  async () => (await import("./organization.create")).organizationCreateHandler as CapabilityHandlerFn,
);
registerHandler(
  "workspace.create",
  async () =>
    (await import("./workspace.create")).workspaceCreateHandler as CapabilityHandlerFn,
);
registerHandler(
  "billing.subscription.read",
  async () =>
    (await import("./billing.subscription.read"))
      .billingSubscriptionReadHandler as CapabilityHandlerFn,
);
registerHandler(
  "billing.subscription.upgrade.start",
  async () =>
    (await import("./billing.subscription.upgrade.start"))
      .billingSubscriptionUpgradeStartHandler as CapabilityHandlerFn,
);
registerHandler(
  "billing.credits.purchase",
  async () =>
    (await import("./billing.credits.purchase"))
      .billingCreditsPurchaseHandler as CapabilityHandlerFn,
);
registerHandler(
  "chat.message.send",
  async () =>
    (await import("./chat.message.send")).chatMessageSendHandler as CapabilityHandlerFn,
);
registerHandler(
  "form.fill",
  async () =>
    (await import("./form.fill")).formFillHandler as CapabilityHandlerFn,
);
registerHandler(
  "documents.generate",
  async () =>
    (await import("./documents.generate")).documentsGenerateHandler as CapabilityHandlerFn,
);
registerHandler(
  "documents.pdf.create",
  async () =>
    (await import("./documents.pdf.create")).documentsPdfCreateHandler as CapabilityHandlerFn,
);
registerHandler(
  "brandkit.apply",
  async () =>
    (await import("./brandkit.apply")).brandkitApplyHandler as CapabilityHandlerFn,
);
registerHandler(
  "video.generate",
  async () =>
    (await import("./video.generate")).videoGenerateHandler as CapabilityHandlerFn,
);
registerHandler(
  "svg.generate",
  async () =>
    (await import("./svg.generate")).svgGenerateHandler as CapabilityHandlerFn,
);
registerHandler(
  "image.generate",
  async () =>
    (await import("./image.generate")).imageGenerateHandler as CapabilityHandlerFn,
);
registerHandler(
  "system.install.instructions",
  async () =>
    (await import("./system.install.instructions"))
      .systemInstallInstructionsHandler as CapabilityHandlerFn,
);
registerHandler(
  "org.member.add",
  async () =>
    (await import("./org.member.add")).orgMemberAddHandler as CapabilityHandlerFn,
);
registerHandler(
  "org.member.invite.accept",
  async () =>
    (await import("./org.member.invite.accept")).orgMemberInviteAcceptHandler as CapabilityHandlerFn,
);
registerHandler(
  "org.member.invite.decline",
  async () =>
    (await import("./org.member.invite.decline")).orgMemberInviteDeclineHandler as CapabilityHandlerFn,
);
