# Containment receipt review

The server accepts a containment receipt only from the enrolled host's gateway credential, with active-host and current operator-role checks. Registration does not count as gateway traffic. Ingest requires the receipt's immutable genesis to match a verified chain that also reached the existing gateway evidence threshold. The trust boundary remains the registered launcher and daemon, not a hostile host administrator.

The parent audited the core implementation and found a replay-grade equality check that would cap contained runs. The check now treats contained as at least gateway, with a discriminating grade test. Authentication, immutable retries, tenant predicates, rollout, and signed-chain tier integration have authored tests. No local tests ran; configured hooks and CI provide verification.
