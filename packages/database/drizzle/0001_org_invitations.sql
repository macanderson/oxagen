-- 0001_org_invitations.sql
--
-- Adds org.invitations: invitation-to-org table that also acts as a seat
-- reservation. Pending invitations count as used seats; accepting turns the
-- invitation into an org_users row. Includes a partial unique index that
-- prevents duplicate pending invitations per (orgId, email).
--
-- Idempotent: uses IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS org.invitations (
    id              uuid        NOT NULL DEFAULT COALESCE(
                                    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                        THEN uuid_generate_v7()
                                        ELSE uuid_generate_v4()
                                    END,
                                    uuid_generate_v4()
                                ),
    public_id       citext      NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    created_by_user_id  uuid,
    updated_by_user_id  uuid,
    org_id              uuid        NOT NULL,
    email               citext      NOT NULL,
    role                text        NOT NULL,
    -- 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'
    status              text        NOT NULL DEFAULT 'pending',
    invited_by_user_id  uuid        NOT NULL,
    accepted_user_id    uuid,
    expires_at          timestamptz,

    CONSTRAINT invitations_pkey PRIMARY KEY (id),
    CONSTRAINT invitations_public_id_unique UNIQUE (public_id),
    CONSTRAINT invitations_status_check CHECK (
        status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')
    )
);

CREATE INDEX IF NOT EXISTS invitations_org_status_idx
    ON org.invitations (org_id, status);

-- Partial unique: only one pending invite per (orgId, email).
-- Historical (accepted/declined/revoked/expired) rows are not blocked.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_org_email_pending_idx
    ON org.invitations (org_id, email)
    WHERE status = 'pending';
