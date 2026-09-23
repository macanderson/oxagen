# register_contained_launch

Register the trusted host launcher's measured Docker profile before starting a contained agent. The API requires the enrolled host's gateway credential; the ingest credential and personal credentials cannot register launches.

**Surfaces:** api

The request binds one host, session UUID, and genesis hash to an immutable container measurement. Retries with the same measurement succeed; changes are refused. A registration alone does not raise the session tier. Ingest also requires a verified chain with matching genesis and gateway traffic evidence. Sealed tiers remain final.

This is the registered launcher's attestation about its container. It does not establish resistance to a hostile host administrator. See ADR-152 for the launcher profile and trust boundary.
