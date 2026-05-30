# 9. Observability, Instrumentation, and Production Readiness

- All code is production-grade on first merge. Structured logging with appropriate levels (`debug`, `info`, `warning`, `error`) at every meaningful boundary and failure path. Log everywhere it makes sense; never log secrets or PII in violation of the compliance non-negotiables.
- No `print` debugging left in. No swallowed exceptions. Errors are logged with context and either handled or propagated deliberately.
- **Instrument everything through the shared analytics package.** All telemetry, events, and metrics route through one shared package, never a direct vendor SDK call from app code. The package emits using industry-standard formats (OpenTelemetry semantics) and can write to any endpoint via a swappable exporter, keeping us vendor-neutral per Section 2.
- Adding instrumentation means calling the shared package, not wiring a new analytics dependency. One seam, any backend.
- Separation of concerns is enforced: transport, business logic, and persistence are distinct layers. Routes do not contain business logic; business logic does not import the web framework.
- Data is encrypted at rest per the non-negotiables. Secrets come from a managed secret store, never from source or plaintext config.

### 9.1 Frontend

- **Mobile-first is mandatory.** Interfaces are designed thumb-first; every primary action is reachable and tappable one-handed. The mobile experience is the priority, and the desktop layout adapts up from it, never the reverse.
- Every app supports light and dark mode where it has a UI. Logos and favicons are adaptive SVGs that switch with the theme.
