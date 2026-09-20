# External MCP admission

Approval identity must include the invocation, not only the conversation message and tool. Concurrent calls can share those fields while carrying different inputs. Give each external invocation a unique tool-call ID and bind its approval proof to the input and current rule document.

Every interactive wait can make earlier authorization stale. After consent and approval, refresh IAM and make the final rule check non-interactive. A newly required approval at that boundary refuses instead of inserting another wait after the IAM refresh.

An external tool with no declared measures cannot silently count as a zero-cost mandate action. Refuse that authority path explicitly and document the contract needed to support it.
