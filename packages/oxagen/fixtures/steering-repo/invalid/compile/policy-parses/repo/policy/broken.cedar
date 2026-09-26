// A rule with a syntax error: the when clause is not closed.
@id("broken.syntax")
forbid (principal, action == Action::"billing__create_refund", resource)
when { context.args has amount && context.args.amount > 10000
