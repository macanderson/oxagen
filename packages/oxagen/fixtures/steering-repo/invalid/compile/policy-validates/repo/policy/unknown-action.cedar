// Names an action the schema does not declare.
@id("invoice.void-never")
forbid (principal, action == Action::"billing__void_invoice", resource);
