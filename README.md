<img src="assets/logo.png" width="64" alt="">

# katasync

Inventory, purchasing, and order fulfillment for Shopify, Amazon, eBay, and TikTok Shop. Replaces Sumtracker.

Stack: TanStack Start (React + Vite) on Vercel, Postgres on Neon via Drizzle, Trigger.dev for background jobs.

## Setup

1. `pnpm install`
2. `neon link --project-id mute-paper-12299244 --branch dev` (writes `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to `.env.local`). Develop against the `dev` branch; `production` stays empty until cutover.
3. `pnpm db:migrate`
4. `pnpm dev` (http://127.0.0.1:3000). To reach it from other devices: `tailscale serve --bg --https=3000 http://127.0.0.1:3000`.

`pnpm test` runs against an in-memory Postgres (PGlite) and needs no database.

## Schema changes

Edit `src/db/schema.ts`, then `pnpm db:generate` and commit the new file in `drizzle/`. For SQL that Drizzle can't express (triggers, functions), use `pnpm db:generate --custom --name <name>`.

## Inventory model

- **Locations** are `owned` (we pick from them) or `fba` (Amazon's stock, mirrored read-only).
- **Products** are the canonical record for one SKU: name, image, barcode, cost, weight, and box size. Each is `simple`, `kit` (pre-assembled, has its own stock), or `bundle` (virtual, availability comes from components). Kits hold simple products; bundles hold simple products or kits.
- **Product groups** collect variants (e.g. one flat box in several sizes) for display. Stock and listings work on individual products.
- **Movements** are the append-only ledger. The database rejects edits and deletes; fix mistakes with a new movement.
- **Stock levels** are the running balance of movements per SKU and location, updated in the same transaction. They can go negative when a channel oversells.

- **Stores** are connected seller accounts (a channel plus a name). **Listings** are what each store sells, each mapped to one product. A multi-pack is a bundle product. FBA listings must map to a simple product or kit, since Amazon stocks physical units.

All stock changes go through `src/inventory/ledger.ts`. Mapping rules live in `src/channels/listings.ts`.
