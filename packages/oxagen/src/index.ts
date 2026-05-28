export * from "./types.js";
export * from "./registry.js";

// Capabilities auto-register on import. Foundation milestone ships these
// stubs to validate the contract loop end-to-end; agent / workflow
// capabilities arrive in follow-on epics.
import "./capabilities/tenant.create.js";
import "./capabilities/workspace.create.js";
import "./capabilities/billing.subscription.read.js";
import "./capabilities/chat.message.send.js";
