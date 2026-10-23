# Disaster recovery

katasync keeps its state in one Postgres database on Neon. Everything else (source, Vercel environment variables, channel and carrier credentials) lives outside it and must be recovered separately.

This runbook does not confirm that production backups exist. Verify each item under "Operator must verify" before relying on it.

## What the database holds

A complete recovery needs every table, including these `bytea` columns, which store file bytes in Postgres (there is no object storage):

- `purchase_order_files.data`: PO attachments
- `po_email_attachments.data`: attachments kept from PO emails
- `market_email_attachments.data`: attachments kept from marketplace email
- `purchase_order_damage_photos.data`: damage photos
- `catalog_photos.data`: catalog photos
- `shipments.label_pdf`: saved shipping labels

A dump that omits data (schema only, or CSV of selected tables) loses these files.

The database also holds secrets and session material. Treat every dump as a secret:

- `qz_certificate.private_key`: the QZ Tray signing key (see README, Label printing)
- `sessions.token_hash`, `passkeys`, `oauth_tokens.token_hash`, and the `katasync_mcp` password

Vercel environment variables (`DATABASE_URL`, `CRON_SECRET`, `AUTH_ORIGIN`, channel and carrier keys, `RESEND_API_KEY`, and the rest in `src/`) are not in the database. Recovery needs them restored or re-entered in the same environment.

## Two recovery paths

**Provider point-in-time recovery (Neon).** Neon can reset a branch to a past moment inside the project's history window. The window depends on the plan. Restoring overwrites the branch's current data, and Neon keeps the pre-restore state as a separate branch named `{branch_name}_old_{head_timestamp}`. See [Neon branch restore](https://neon.com/docs/introduction/branch-restore.md) and the [history window](https://neon.com/docs/postgres/backup-restore/history-window) page for the amounts. This path lives inside Neon. It is not a copy you hold.

**Portable dump (`pg_dump`).** A dump is a copy you store outside Neon and can restore to any Postgres. Nothing in this repo creates one yet, and this runbook adds no tooling for it. The commands below use the stock PostgreSQL client tools against the direct connection. Neon's [connection pooling](https://neon.com/docs/connect/connection-pooling.md) page explains why dumps must not use the pooled URL.

## Compatibility: app commit and migrations

A database and an app commit must match. The database records applied migrations in `drizzle.__drizzle_migrations`. The app commit records the expected ones in `drizzle/meta/_journal.json`.

1. Note the app commit that matches the data (the commit deployed when the data was taken).
2. At the app commit, count the journal entries and the last tag.
3. Against the restored database:

   ```sql
   select count(*), max(created_at) from drizzle.__drizzle_migrations;
   ```

   The count must equal the journal entry count. If the database is behind, run `pnpm db:migrate` against it. That script refuses to apply when migrations would be skipped (`scripts/migrate.ts`, `scripts/check-migrations.ts`).

4. If the database is ahead of the app commit, deploy the app that knows its schema. Do not roll back code alone. The README's dispatch cutover (migrations `0031` to `0035`) requires restoring both the database and the app.

Never run migrations against production from a restored copy. Migrate only the rehearsal database below.

## Keep credentials out of logs

- Read `DATABASE_URL_UNPOOLED` from `.env.local` (gitignored, written by `neon link`) or a secret manager. Do not paste the connection string into commands, tickets, chat, or shell history.
- Do not run with `set -x` or `pg_dump -v` around a URL.
- Write dumps with `umask 077` to a directory outside the repo. `.gitignore` does not exclude dumps.
- A rehearsal env file holds only the rehearsal `DATABASE_URL`. Do not copy channel credentials into it.

## Take a dump

```sh
umask 077
pg_dump -Fd -j 4 --no-owner --no-privileges \
  -f "$DUMP_DIR/katasync-$(date -u +%Y%m%dT%H%MZ).dir" \
  "$DATABASE_URL_UNPOOLED"
```

`-Fd` with `-j` runs in parallel. `pg_dump` takes a consistent snapshot while the app keeps writing. [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) requires that the target directory not exist. Record the source (branch and point in time), the app commit, and the migration count (see Recovery evidence).

## Isolated restore rehearsal

Rehearse on a new Neon branch or a fresh database that no app or cron uses. Never use `production`, and never point Vercel at it.

1. Confirm the archive is readable:

   ```sh
   pg_restore -l "$DUMP_DIR/katasync-....dir" > /dev/null
   ```

   [`pg_restore -l`](https://www.postgresql.org/docs/current/app-pgrestore.html) reads the table of contents. It does not verify table data.

2. Restore into the empty rehearsal database:

   ```sh
   pg_restore -j 4 --no-owner --no-privileges \
     -d "$REHEARSAL_URL" "$DUMP_DIR/katasync-....dir" 2> "$DUMP_DIR/restore.log"
   ```

   `-j` needs a custom or directory archive. Review `restore.log`. Role and ACL errors can be expected on Neon. Any other error fails the rehearsal.

3. Check the migration count (step 3 above) and run `DATABASE_URL_UNPOOLED="$REHEARSAL_URL" pnpm db:migrate` at the app commit. It should apply nothing.

4. Run the integrity checks below.

5. Optional: run the app locally at the app commit with the rehearsal `DATABASE_URL` in an env file that has no channel credentials. Do not run `pnpm sync`, `pnpm webhooks`, or any `stock:*` script. They call Shopify, Amazon, eBay, and TikTok with live credentials, and stock push writes listing quantities.

## Integrity checks

Run against the restored database and compare with the source. Exact counts and byte totals are the evidence; the table constraints already reject bad sizes, so only missing or truncated rows show up here.

```sql
-- Ledger: running balances equal the sum of movements
select coalesce(s.product_id, m.product_id) as product_id,
       coalesce(s.location_id, m.location_id) as location_id
from stock_levels s
full join (
  select product_id, location_id, sum(delta) as total
  from movements group by product_id, location_id
) m on m.product_id = s.product_id and m.location_id = s.location_id
where coalesce(s.on_hand, 0) <> coalesce(m.total, 0);
```

```sql
-- Attachments and photos: row counts and total bytes
select 'purchase_order_files' as tbl, count(*) as n, sum(octet_length(data)) as bytes from purchase_order_files
union all select 'po_email_attachments', count(*), sum(octet_length(data)) from po_email_attachments
union all select 'market_email_attachments', count(*), sum(octet_length(data)) from market_email_attachments
union all select 'purchase_order_damage_photos', count(*), sum(octet_length(data)) from purchase_order_damage_photos
union all select 'catalog_photos', count(*), sum(octet_length(data)) from catalog_photos
union all select 'shipments_label_pdf', count(*), sum(octet_length(label_pdf)) from shipments where label_pdf is not null;
```

The ledger query must return no rows. The attachment query must match the source exactly. Also compare counts for `movements`, `orders`, `purchase_orders`, and `stock_levels`.

## Recovery evidence

Record one entry per restore or rehearsal, in the incident note or a dated log. Do not record connection strings or secrets.

- Source: Neon branch and timestamp, or dump directory name and its SHA-256
- App commit SHA deployed or tested
- Last migration tag and migration count, before and after
- Row counts and byte totals for the tables above, source versus restored
- Ledger check result (zero rows)
- Rehearsal result, who ran it, and when

## Operator must verify

- The Neon plan and its history window, and whether the `production` branch holds live data (the README says it stays empty until cutover).
- Whether any Neon backup or snapshot feature is enabled for the project. This runbook does not rely on one.
- Where a portable dump would be stored, who can read it, and how long it is kept.
- That the Vercel environment and every channel, carrier, and email credential can be restored or re-issued.
- That a rehearsal has run at least once with the commands above.
