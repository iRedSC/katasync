# Disaster recovery

katasync keeps its state in one Postgres database on Neon. Source, Vercel environment variables, and channel and carrier credentials live outside it and must be recovered separately.

This runbook does not confirm that production backups exist. Verify each item under "Operator must verify" before relying on it.

## What the database holds

A complete recovery needs every table, including these `bytea` columns, which store file bytes in Postgres (there is no object storage):

- `purchase_order_files.data`: PO attachments
- `po_email_attachments.data`: attachments kept from PO emails
- `market_email_attachments.data`: attachments kept from marketplace email
- `purchase_order_damage_photos.data`: damage photos
- `catalog_photos.data`: catalog photos
- `shipments.label_pdf`: saved shipping labels

A dump that omits data (schema only, or selected tables) loses these files.

The database also holds secrets. Treat every dump as a secret:

- `qz_certificate.private_key`: the QZ Tray signing key (see README, Label printing)
- `mcp_login.password`: the password the MCP query tool uses
- `sessions.token_hash`, `passkeys`, `oauth_tokens.token_hash`

Vercel environment variables (`DATABASE_URL`, `CRON_SECRET`, `AUTH_ORIGIN`, channel, carrier, and email keys) are not in the database. Recovery needs them restored or re-issued in the same environment.

## Two recovery paths

**Provider point-in-time recovery (Neon).** Neon can reset a branch to a past moment inside the project's history window, which depends on the plan. Restoring overwrites the branch's current data, and Neon keeps the pre-restore state as a branch named `{branch_name}_old_{head_timestamp}`. See [Neon branch restore](https://neon.com/docs/introduction/branch-restore.md) and the [history window](https://neon.com/docs/postgres/backup-restore/history-window) page for the amounts. This path lives inside Neon. It is not a copy you hold.

**Portable dump (`pg_dump`).** A dump is a copy you store outside Neon and can restore to any Postgres. Nothing in this repo creates one, and this runbook adds no tooling for it. The steps use the stock PostgreSQL client tools against the direct connection. Neon's [connection pooling](https://neon.com/docs/connect/connection-pooling.md) page explains why dumps must not use the pooled URL.

## Credentials

Never put a connection string or password on a command line. Process arguments are visible to other users on the machine. Keep the connection details in files outside the repo, created by the operator:

`~/katasync-dr/pg_service.conf` (no secrets; mode 0600 is fine):

```ini
[katasync_src]
host=<direct host, no -pooler>
dbname=<database>
user=<role>
sslmode=require

[katasync_rehearsal]
host=<rehearsal branch direct host>
dbname=<database>
user=<role>
sslmode=require
```

`~/katasync-dr/pgpass` (secret; must be mode 0600 or libpq ignores it):

```text
<host>:5432:<database>:<role>:<password>
```

Then, in each shell, before any command below:

```sh
export PGSERVICEFILE="$HOME/katasync-dr/pg_service.conf" PGPASSFILE="$HOME/katasync-dr/pgpass"
umask 077
```

Commands select a target with `PGSERVICE=katasync_src` or `PGSERVICE=katasync_rehearsal`. See [libpq connection service file](https://www.postgresql.org/docs/current/libpq-pgservice.html) and [password file](https://www.postgresql.org/docs/current/libpq-pgpass.html).

- Do not use `PGPASSWORD`, `set -x`, `pg_dump -v`, or `psql -E`.
- Do not source the repo's `.env.local` in a DR shell. It holds the live URLs, and `drizzle.config.ts` and `scripts/migrate.ts` read `DATABASE_URL_UNPOOLED` from it.
- Keep dumps and logs in `~/katasync-dr/`, outside the repo. `.gitignore` does not exclude them.

## Dump options

`--no-owner` omits ownership statements, so the dump restores under any role. `--no-privileges` is not used. It would drop the `GRANT` and `REVOKE` statements that keep `katasync_mcp` read-only (`drizzle/0027_mcp_role.sql` and the per-table grants in later migrations). A restore cannot rebuild them without replaying migrations, and replaying migrations against live-shaped data is not safe.

`pg_dump` never includes cluster roles, with or without these flags. Roles, role passwords, and role settings (`ALTER ROLE ... SET`) are set up separately on the target (see Restore rehearsal).

## Source and snapshot

Every count, digest, and migration list is taken from the same source state as the dump:

- **(a)** a Neon branch created at a fixed point in history, which nothing writes to; or
- **(b)** production, with every writer stopped first: Vercel crons and app traffic, the packing and sync processes, and MCP clients.

Run the source checks before the dump starts and again after it ends, with the same results. If any writer ran in between, discard the dump and start over. Counts from a live database that is still writing will not match the dump.

## Take a dump

```sh
export DUMP="$HOME/katasync-dr/dumps/katasync-$(date -u +%Y%m%dT%H%M%SZ).dir"
PGSERVICE=katasync_src pg_dump -Fd -j 4 --no-owner -f "$DUMP"
(cd "$DUMP" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$DUMP.manifest.sha256"
```

`-Fd` with `-j` dumps in parallel. The target directory must not exist. [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) takes a consistent snapshot.

The manifest lists the SHA-256 of every file in the directory, with paths relative to it. It sits beside the directory, not inside it, so it does not list itself.

Record the source (branch and timestamp, or production with writers stopped), the app commit, and the migration list (see Compatibility).

## Compatibility: migrations and app commit

A backup matches an app commit only if the database's applied migrations are identical, in order, to the migrations that commit ships. Migration count and latest timestamp do not prove this. Compare the whole list of hashes and timestamps.

Expected list, from a clean checkout of the app commit (`pnpm install --frozen-lockfile`; no `.env.local` needed):

```sh
node --input-type=module -e "import { readMigrationFiles } from 'drizzle-orm/migrator'; console.log(JSON.stringify(readMigrationFiles({ migrationsFolder: 'drizzle' }).map((m) => [m.hash, m.folderMillis])))" > "$DUMP.expected-migrations.json"
```

Actual list, from a database (source or rehearsal):

```sh
PGSERVICE=katasync_src psql -X -At -v ON_ERROR_STOP=1 -c "select json_agg(json_build_array(hash, created_at) order by created_at) from drizzle.__drizzle_migrations" > "$DUMP.actual-migrations.json"
```

Match:

```sh
cmp -s <(jq -c . "$DUMP.expected-migrations.json") <(jq -c . "$DUMP.actual-migrations.json")
```

Exit status 0 means a match. Anything else means the backup is not for that commit: stop, and deploy the commit that matches it, or treat it as a separate migration decision.

Do not use `pnpm db:migrate` to check a backup. It applies pending migrations and only refuses skipped ones. It does not prove the lists are identical.

## Restore rehearsal

Use a new Neon branch or an empty database created only for this rehearsal. It must never be `production`, the branch Vercel uses, or the source. Its entry in `pg_service.conf` is `katasync_rehearsal`.

1. Verify the dump is unchanged since it was taken:

   ```sh
   (cd "$DUMP" && sha256sum -c "$DUMP.manifest.sha256" --quiet) && echo manifest-ok
   ```

   Any `FAILED` line means stop.

2. Create the role the dump's grants name. Roles are cluster-level and are not in the dump:

   ```sh
   PGSERVICE=katasync_rehearsal psql -X -v ON_ERROR_STOP=1 -c "do \$\$ begin if not exists (select from pg_roles where rolname = 'katasync_mcp') then create role katasync_mcp login; end if; end \$\$"
   ```

   This matches `drizzle/0027_mcp_role.sql`, without a password.

3. Restore, stopping at the first error:

   ```sh
   pg_restore --exit-on-error -j 4 --no-owner -d "service=katasync_rehearsal" "$DUMP" > "$DUMP.restore.log" 2>&1
   echo "exit=$?"
   ```

   Exit status must be 0, and the log must contain no `ERROR:` line. Any error, including a missing role or a grant on a missing object, fails the rehearsal. Do not add flags to suppress errors. Fix the cause, drop the rehearsal database, and start again from step 2.

   [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html) `--exit-on-error` stops at the first error, so the state after a failure is partial, not usable.

4. Re-apply the settings and password that a dump does not carry:

   ```sh
   PGSERVICE=katasync_rehearsal psql -X -v ON_ERROR_STOP=1 -c "alter role katasync_mcp set statement_timeout = '15s'"
   PGSERVICE=katasync_src psql -X -At -v ON_ERROR_STOP=1 -c "select format('alter role katasync_mcp password %L', password) from mcp_login" | PGSERVICE=katasync_rehearsal psql -X -q -v ON_ERROR_STOP=1 -f -
   ```

   The timeout comes from `drizzle/0027_mcp_role.sql`. The password is piped between `psql` processes and never written to a file or argv. If `mcp_login` has no row, the app had never used the MCP role; skip the password line and record that.

5. Migration list: run the actual-migrations command against `katasync_rehearsal` and compare with `cmp -s` as above. It must match the expected list exactly.

6. Grant check: the MCP role must read the same relations as on the source, and no secret table. Save the output from each side and diff them. Run on `katasync_src` and on `katasync_rehearsal`:

   ```sql
   select c.relname, has_table_privilege('katasync_mcp', c.oid, 'SELECT') as mcp_can_read
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
   order by 1;
   ```

   The two outputs must be identical, and `sessions`, `passkeys`, `oauth_tokens`, `qz_certificate`, and `mcp_login` must show `f`. The full list of secret tables is `SECRET_TABLES` in `src/mcp/query.ts`; every one of them must show `f`.

7. Optional: connect as `katasync_mcp` on the rehearsal with a `pgpass` line for the rehearsal entry, and run `select 1`. This proves the login works without the app.

8. Integrity checks, read-only, against the source and the rehearsal. Save this as a file outside the repo and run `PGSERVICE=<target> psql -X -At -v ON_ERROR_STOP=1 -f integrity.sql > "$DUMP.integrity.<target>.txt"`. Diff the two outputs. They must be identical, and the ledger check must return no rows on both.

   ```sql
   begin isolation level repeatable read read only;

   select 'movements' as tbl, count(*) as n, null::bigint as bytes from movements
   union all select 'stock_levels', count(*), null from stock_levels
   union all select 'orders', count(*), null from orders
   union all select 'purchase_orders', count(*), null from purchase_orders
   union all select 'purchase_order_files', count(*), sum(octet_length(data)) from purchase_order_files
   union all select 'po_email_attachments', count(*), sum(octet_length(data)) from po_email_attachments
   union all select 'market_email_attachments', count(*), sum(octet_length(data)) from market_email_attachments
   union all select 'purchase_order_damage_photos', count(*), sum(octet_length(data)) from purchase_order_damage_photos
   union all select 'catalog_photos', count(*), sum(octet_length(data)) from catalog_photos
   union all select 'shipments_label_pdf', count(*), sum(octet_length(label_pdf)) from shipments where label_pdf is not null;

   select 'purchase_order_files' as tbl, md5(string_agg(id::text || ':' || md5(data), ',' order by id)) as digest from purchase_order_files
   union all select 'po_email_attachments', md5(string_agg(id::text || ':' || md5(data), ',' order by id)) from po_email_attachments
   union all select 'market_email_attachments', md5(string_agg(id::text || ':' || md5(data), ',' order by id)) from market_email_attachments
   union all select 'purchase_order_damage_photos', md5(string_agg(id::text || ':' || md5(data), ',' order by id)) from purchase_order_damage_photos
   union all select 'catalog_photos', md5(string_agg(id::text || ':' || md5(data), ',' order by id)) from catalog_photos
   union all select 'shipments_label_pdf', md5(string_agg(id::text || ':' || md5(label_pdf), ',' order by id)) from shipments where label_pdf is not null;

   select product_id, location_id, on_hand, total
   from stock_levels full join (
     select product_id, location_id, sum(delta) as total from movements group by product_id, location_id
   ) m using (product_id, location_id)
   where coalesce(on_hand, 0) <> coalesce(total, 0);

   commit;
   ```

   Counts show missing or extra rows. Digests show the attachment bytes are identical to the source row by row. The ledger query checks that stored balances equal the sum of movements. Each query runs in one repeatable-read transaction, so they see one snapshot.

## Optional: migrate the rehearsal

Only if the backup is behind the app commit and you want to see the forward path work. This is not validation, and it must never target anything else:

1. Use a clean checkout of the app commit with no `.env.local`.
2. Create `~/katasync-dr/rehearsal.env` (mode 0600, outside the repo) with only `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, both set to the rehearsal branch.
3. `set -a; . ~/katasync-dr/rehearsal.env; set +a; pnpm db:migrate`
4. Repeat the migration-list comparison. It must match the expected list.

## Recovery evidence

Record one entry per restore or rehearsal, in the incident note or a dated log. Never record connection strings, passwords, or the QZ key.

- Source: Neon branch and timestamp, or production with writers stopped (start and end times)
- Dump directory name, manifest file, and the output of `sha256sum -c`
- App commit SHA, and the expected and actual migration lists (`cmp` exit status)
- `pg_restore` exit status and log line count of `ERROR:` (must be 0)
- The grant comparison diff (must be empty)
- The integrity outputs, source and rehearsal, and their diff (must be empty)
- Who ran it and when

## Operator must verify

- The Neon plan and history window, and whether `production` holds live data. The README says it stays empty until cutover.
- Whether a Neon snapshot or backup feature is enabled for the project. This runbook does not rely on one.
- Where dumps are stored, who can read them, and for how long. They contain the QZ key and MCP password.
- That the Neon role you connect as may create `katasync_mcp` and run `alter role` on the rehearsal branch.
- That the Vercel environment and every channel, carrier, and email credential can be restored or re-issued.
- That the rehearsal has run at least once with these steps.
