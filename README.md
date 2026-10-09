<img src="assets/icon.svg" width="64" height="64" alt="">

# katasync

Inventory, purchasing, and order fulfillment for Shopify, Amazon, eBay, and TikTok Shop. Replaces Sumtracker.

Stack: TanStack Start (React + Vite) on Vercel, Postgres on Neon via Drizzle, Trigger.dev for background jobs.

## Setup

1. `pnpm install`
2. Create a Neon project, copy `.env.example` to `.env`, and set `DATABASE_URL`.
3. `pnpm db:migrate`
4. `pnpm dev` (http://localhost:3000)

`pnpm test` runs against an in-memory Postgres (PGlite) and needs no database.

## Schema changes

Edit `src/db/schema.ts`, then `pnpm db:generate` and commit the new file in `drizzle/`. For SQL that Drizzle can't express (triggers, functions), use `pnpm db:generate --custom --name <name>`.

## Inventory model

- **Locations** are `owned` (we pick from them) or `fba` (Amazon's stock, mirrored read-only).
- **SKUs** are `simple`, `kit` (pre-assembled, has its own stock), or `bundle` (virtual, availability comes from components). Kits hold simple SKUs; bundles hold simple SKUs or kits.
- **Movements** are the append-only ledger. The database rejects edits and deletes; fix mistakes with a new movement.
- **Stock levels** are the running balance of movements per SKU and location, updated in the same transaction. They can go negative when a channel oversells.

All stock changes go through `src/inventory/ledger.ts`.
