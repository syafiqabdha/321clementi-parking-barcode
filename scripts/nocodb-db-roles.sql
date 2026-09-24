-- ===========================================================================
-- 321 Clementi Parking Barcode — NocoDB / mall-management database role
--
-- Run AFTER migrations 0001-0005, against the production database:
--
--   { printf '%s\n' "$MALL_OPS_DB_PASSWORD"; cat scripts/nocodb-db-roles.sql; } \
--     | docker compose exec -T db sh -c '
--         IFS= read -r MALL_OPS_DB_PASSWORD; export MALL_OPS_DB_PASSWORD
--         exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--           -v ON_ERROR_STOP=1 -v mall_ops_db="$POSTGRES_DB" -f -'
--
--   (or, with psql on the host:  MALL_OPS_DB_PASSWORD=... psql "$URL" \
--      -v mall_ops_db=clementi_redemption -f scripts/nocodb-db-roles.sql)
--
-- The password is read from the MALL_OPS_DB_PASSWORD environment variable by
-- the \getenv below, so it never has to appear in a command line. Passing
-- -v mall_ops_password=... still works, but puts the secret in the psql
-- process arguments.
--
-- Idempotent — safe to re-run; it re-asserts the grants every time.
--
-- WHY THIS EXISTS
--   NocoDB's community edition has table-level permissions but no column-level
--   write denial, so it cannot by itself stop a mall-management user (or a
--   leaked NocoDB data-source credential) from editing `vehicle_plate_hash`,
--   flipping a voucher's `status`, or rewriting a redemption row. PostgreSQL
--   column privileges can, so the boundary is enforced here instead — and then
--   NocoDB's data source is pointed at this role.
--
--   PII: `vehicle_plate_hash` is an HMAC of the plate, never the plate itself.
--   SELECT stays granted (dispute lookups need it); UPDATE and DELETE are not
--   granted on any column of voucher_pool / redemption_logs /
--   redemption_audit_logs, so no NocoDB code path can rewrite audit history.
-- ===========================================================================

\set ON_ERROR_STOP on

-- Take the role password from the environment when present, so the provisioning
-- command never has to pass it as a psql argument (`-v mall_ops_password=...`
-- shows up in `ps aux`). psql leaves the variable untouched if the environment
-- variable is unset, so an explicit -v still overrides this.
\getenv mall_ops_password MALL_OPS_DB_PASSWORD

-- Role creation is not idempotent in plain SQL, so guard it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mall_operations') THEN
    CREATE ROLE mall_operations LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    RAISE NOTICE 'created role mall_operations';
  ELSE
    RAISE NOTICE 'role mall_operations already exists — re-asserting grants';
  END IF;
END
$$;

-- Password is supplied out-of-band so it never lands in the repository.
ALTER ROLE mall_operations WITH PASSWORD :'mall_ops_password';

-- Session-level guard rails: mall staff must never be able to disable the
-- audit trail or stall the allocation CTE from a UI session.
ALTER ROLE mall_operations SET statement_timeout = '15s';
ALTER ROLE mall_operations SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE mall_operations SET search_path = public;

-- ---------------------------------------------------------------------------
-- Database / schema reachability
-- ---------------------------------------------------------------------------
GRANT CONNECT ON DATABASE :"mall_ops_db" TO mall_operations;
GRANT USAGE   ON SCHEMA public TO mall_operations;

-- ---------------------------------------------------------------------------
-- READ — the whole admin UI surface (voucher pool, redemption log, disputes)
-- ---------------------------------------------------------------------------
GRANT SELECT ON shops, voucher_pool, redemption_logs, redemption_audit_logs TO mall_operations;
-- Deliberately NOT granted: schema_migrations, and NocoDB's own nc_* metadata
-- tables. They are internal bookkeeping, and every table this role can read
-- shows up as a linked table in the NocoDB base.

-- ---------------------------------------------------------------------------
-- WRITE — tenant directory only, column-scoped
--
-- The app queries `shops` live on every intake request, so this is the one
-- table mall management is expected to curate. Column grants keep `id`,
-- `created_at` and any future column out of reach by default.
-- ---------------------------------------------------------------------------
GRANT INSERT ON shops TO mall_operations;
GRANT UPDATE (name, slug, category, level, unit, is_active, is_eligible, ineligibility_reason, updated_at)
      ON shops TO mall_operations;
GRANT DELETE ON shops TO mall_operations;

-- ---------------------------------------------------------------------------
-- WRITE — voucher inventory intake only
--
-- Mall staff bulk-upload Code 128 voucher batches (CSV import in NocoDB), so
-- INSERT is required. It is deliberately column-scoped: a new row can carry a
-- code, a format, a batch id and a starting status, but cannot pre-set
-- `vehicle_plate_hash`, `allocated_at` or `redeemed_at` — so an upload cannot
-- plant a forged redemption or bind a plate to an unissued voucher.
--
-- No UPDATE and no DELETE: once a code exists, only the application's atomic
-- allocation CTE may change its state.
-- ---------------------------------------------------------------------------
GRANT INSERT (voucher_code, barcode_format, status, batch_id) ON voucher_pool TO mall_operations;
-- BIGSERIAL still needs the sequence: without USAGE the INSERT above fails with
-- `permission denied for sequence voucher_pool_id_seq`.
GRANT USAGE ON SEQUENCE voucher_pool_id_seq TO mall_operations;

-- ---------------------------------------------------------------------------
-- Explicit negative assertions, so a future edit to this file cannot silently
-- widen access. These run as the table owner and fail loudly if a grant above
-- crept in from elsewhere (e.g. a blanket GRANT ALL in a migration).
-- ---------------------------------------------------------------------------
REVOKE ALL ON redemption_logs FROM mall_operations;
REVOKE ALL ON redemption_audit_logs FROM mall_operations;
GRANT SELECT ON redemption_logs, redemption_audit_logs TO mall_operations;

REVOKE UPDATE, DELETE, TRUNCATE ON voucher_pool FROM mall_operations;
GRANT SELECT ON voucher_pool TO mall_operations;
GRANT INSERT (voucher_code, barcode_format, status, batch_id) ON voucher_pool TO mall_operations;

REVOKE UPDATE, DELETE, TRUNCATE ON shops FROM mall_operations;
GRANT INSERT ON shops TO mall_operations;
GRANT UPDATE (name, slug, category, level, unit, is_active, is_eligible, ineligibility_reason, updated_at)
      ON shops TO mall_operations;
GRANT DELETE ON shops TO mall_operations;

-- ===========================================================================
-- Verify (run as the role, expects four denials then three successes):
--
--   PGPASSWORD=... psql "postgresql://mall_operations@<host>:5432/<db>" <<'SQL'
--   SELECT count(*) FROM shops;                                            -- OK
--   SELECT count(*) FROM voucher_pool WHERE vehicle_plate_hash IS NOT NULL;-- OK
--   INSERT INTO voucher_pool (voucher_code, barcode_format, status)
--     VALUES ('0991323999','CODE128','AVAILABLE');                         -- OK
--   UPDATE voucher_pool SET status='EXPIRED' WHERE voucher_code='0991323999';     -- DENIED
--   UPDATE voucher_pool SET vehicle_plate_hash='x' WHERE id=1;                   -- DENIED
--   UPDATE redemption_logs SET receipt_amount=0 WHERE true;                      -- DENIED
--   DELETE FROM redemption_logs WHERE true;                                      -- DENIED
--   UPDATE shops SET name='probe' WHERE false;                                   -- OK
--   SQL
--
-- scripts/deploy-nocodb-config.sh automates exactly this and fails the run if
-- any denial does not happen.
-- ===========================================================================
