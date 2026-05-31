import { registerHandler, type CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

// Side-effect module: binds every foundation handler to its capability in the
// kernel as a lazy loader. Import once at app boot (api, mcp, cli) before
// dispatching. Loaders are dynamic so booting a surface does not eagerly pull
// in Stripe / Drizzle until a capability is actually invoked.

registerHandler(
  "organization.create",
  async () => (await import("./organization.create.js")).organizationCreateHandler as CapabilityHandlerFn,
);
registerHandler(
  "workspace.create",
  async () =>
    (await import("./workspace.create.js")).workspaceCreateHandler as CapabilityHandlerFn,
);
registerHandler(
  "billing.subscription.read",
  async () =>
    (await import("./billing.subscription.read.js"))
      .billingSubscriptionReadHandler as CapabilityHandlerFn,
);
registerHandler(
  "billing.subscription.upgrade.start",
  async () =>
    (await import("./billing.subscription.upgrade.start.js"))
      .billingSubscriptionUpgradeStartHandler as CapabilityHandlerFn,
);
registerHandler(
  "chat.message.send",
  async () =>
    (await import("./chat.message.send.js")).chatMessageSendHandler as CapabilityHandlerFn,
);
registerHandler(
  "form.fill",
  async () =>
    (await import("./form.fill.js")).formFillHandler as CapabilityHandlerFn,
);
registerHandler(
  "documents.generate",
  async () =>
    (await import("./documents.generate.js")).documentsGenerateHandler as CapabilityHandlerFn,
);
registerHandler(
  "documents.pdf.create",
  async () =>
    (await import("./documents.pdf.create.js")).documentsPdfCreateHandler as CapabilityHandlerFn,
);
registerHandler(
  "brandkit.apply",
  async () =>
    (await import("./brandkit.apply.js")).brandkitApplyHandler as CapabilityHandlerFn,
);
