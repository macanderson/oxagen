-- Row-level security for a new tenant table. Replace <table>.
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;
CREATE POLICY <table>_tenant ON <table>
  USING (org_id = current_setting('app.org_id')::uuid);
-- password: Xk8Qm2Lp9Rv4Tz7Wc3Nb6Hd1Jf5Gs0Ay
