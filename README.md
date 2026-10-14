<img src="assets/logo.svg" width="64" alt="">

# katasync

Inventory, purchasing, and order fulfillment for Shopify, Amazon, eBay, and TikTok Shop. Replaces Sumtracker.

Stack: TanStack Start (React + Vite) on Vercel, Postgres on Neon via Drizzle, Vercel Cron for syncing.

## Setup

1. `pnpm install`
2. `neon link --project-id mute-paper-12299244 --branch dev` (writes `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to `.env.local`). Develop against the `dev` branch; `production` stays empty until cutover.
3. `pnpm db:migrate`
4. `pnpm dev` (http://127.0.0.1:3000). To reach it from other devices: `tailscale serve --bg --https=3000 http://127.0.0.1:3000`.

In production, Vercel Cron runs each channel's sync on the schedules in `vercel.json` (`src/routes/api/cron/sync.$channel.ts`); set `CRON_SECRET` in Vercel to a random string of 16+ characters. Locally, `pnpm sync --watch` pulls orders from every channel whose credentials are in `.env.local` (Shopify; TikTok Shop; Amazon; eBay). Once TikTok has synced, Shopify stops importing the TikTok orders its TikTok channel relays. Quote values that contain `#`, like eBay refresh tokens, or they get cut off.

Shopify and TikTok also send order webhooks to `/api/webhooks/<channel>` (`src/channels/webhooks.ts`), so orders arrive in seconds; the crons stay as the safety net, and eBay and Amazon run on them alone. Set `SHOPIFY_WEBHOOK_SECRET` to the client secret of the Shopify app behind `SHOPIFY_ADMIN_TOKEN`, then run `pnpm webhooks https://<katasync address>` once with production credentials to subscribe. Run it bare to see where each channel sends now.

Webhooks only speed things up; cron is authoritative. If orders go back to taking minutes, run `pnpm webhooks` bare to check the subscriptions; failures are logged, and Shopify emails the app's developer address.

`pnpm test` runs against an in-memory Postgres (PGlite) and needs no database.

## Signing in

Everyone shares one company account; each phone or computer signs in with its own passkey (Settings, then Devices). The dev server skips sign-in.

- `AUTH_ORIGIN` is the address katasync is opened at, e.g. `https://katasync.example.com`. Passkeys belong to that address, so changing it means adding every device again.
- `pnpm auth:setup-link` prints a one-time link for adding a device: the first one, or when every device has lost its passkey.

## Claude (MCP)

`/mcp` is an MCP server (Streamable HTTP, stateless) for Claude and other MCP clients. Make a token in Settings; it shows the `claude mcp add` command to run. Claude can read anything (including read-only SQL), draft POs, receive sent ones, change products and the setup, count stock, ask staff for cycle counts, and build kits; a read-only token gets only the reading tools. Every change it makes is listed on Diagnostics. Sending POs and buying labels stay in the app. Tools live in `src/mcp/server.ts`; the counting rules they rely on are the `owned_stock` and `sales_units` views.

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

Returns are received only after an order is fully shipped. Partially shipped orders do not yet have per-line shipped counts, so receiving their returns is blocked rather than restocking units still awaiting shipment. Bundle returns use the components recorded in the original sale, not the current recipe; historical bundles without a recorded sale must have their returned parts counted individually.
