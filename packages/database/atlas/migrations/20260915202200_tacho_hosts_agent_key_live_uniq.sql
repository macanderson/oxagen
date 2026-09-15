-- A revoked Tacho host gives up its agent key (#2967 review).
--
-- tacho_hosts_agent_key_uniq was UNIQUE on (org_id, agent_key) over every
-- row, and revoke_tacho_enrollment keeps the revoked row. An agent whose host
-- was revoked could therefore never be enrolled again: enroll_host refused
-- every new one-time token with conflict: agent_has_host, and
-- create_tacho_enrollment moved the host to a suffixed key. The index now
-- covers live hosts only, so one agent key has at most one live host and any
-- number of revoked ones.

DROP INDEX "tacho"."tacho_hosts_agent_key_uniq";
CREATE UNIQUE INDEX "tacho_hosts_agent_key_uniq" ON "tacho"."hosts" USING btree ("org_id","agent_key") WHERE ("status" <> 'revoked');
