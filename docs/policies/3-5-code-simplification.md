# 3.5 Code Simplification

The single most expensive mistake in this codebase is designing for a future that never arrives. This section overrides any instinct to "build it right for later."

- **Build for today's requirement only.** Do not design for hypothetical future use cases. The future requirement you imagine is usually wrong, and the abstraction you build for it is always in the way. When the real need arrives, refactor then with real information.
- **YAGNI is enforced, not advisory.** No extension points, plugin systems, generic engines, or configuration surfaces that no current feature uses. If nothing calls it today, it does not get built today.
- **The simplest design that fully satisfies the requirement wins,** even when a more general one is "nicer." Cleverness that adds indirection is a defect.
- **Avoid unnecessary boilerplate.** Prefer auto-discovery and convention over hand-wired registration (Section 7.4). If a pattern forces you to copy ceremony into every new file, fix the pattern.
- **Inline until it hurts.** Do not extract layers, interfaces, or base classes in anticipation of variants. One implementation needs no interface. Introduce the seam when the second real implementation exists.
- **Fewer moving parts.** Prefer a function to a class, a class to a hierarchy, a direct call to an event bus, a column to a side table, until the requirement genuinely demands more.
- **When reviewing your own work, ask: what can I remove and still meet the requirement?** Ship that version.
