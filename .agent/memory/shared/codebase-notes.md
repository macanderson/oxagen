# Shared codebase notes

- Durable `RunSpecV1` does not capture the enqueuing principal; any lifecycle or delegated execution feature that claims IAM equivalence must introduce a versioned principal reference and re-resolve current grants at claim time.
- `CapabilityContext.surface` includes `runner`, while public `CapabilitySurface` does not. Internal lifecycle eligibility should be orthogonal contract metadata, not a spoofed public surface.
