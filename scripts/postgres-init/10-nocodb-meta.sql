-- Runs once, from docker-entrypoint-initdb.d, on first initialisation of the
-- PostgreSQL data volume.
--
-- NocoDB keeps its own metadata in a relational store. Pointed at the
-- application database (`clementi_redemption`), it materialises ~140 `nc_*`
-- tables plus `xc_knex_migrationsv0` into the `public` schema — mixed in with
-- shops / voucher_pool / redemption_logs, listed as linked tables in the
-- admin base, and carried in every pg_dump of production data.
--
-- Giving it its own database keeps the application schema clean.
--
-- NOTE: this only executes on an EMPTY data directory. Adding it to an existing
-- deployment requires creating the database by hand:
--   docker compose exec db psql -U "$POSTGRES_USER" -d postgres \
--     -c 'CREATE DATABASE nocodb_meta;'

SELECT 'CREATE DATABASE nocodb_meta'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'nocodb_meta')\gexec
