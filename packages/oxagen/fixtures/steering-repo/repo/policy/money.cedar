// Refunds above $100 park for a person's approval.
// The record a-intel.billing.refunds-over-100 tells the agent why.
@id("refund.over-100")
@decision("require_approval")
forbid (principal, action == Action::"billing__create_refund", resource)
when { context.args has amount && context.args.amount > 10000 }
unless { context.approval.granted };
