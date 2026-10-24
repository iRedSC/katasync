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

Shopify's shipping email links to the storefront's tracking page (`src/shipping/tracking-link.ts`). Set `STOREFRONT_ORIGIN` (e.g. `https://eastcoastdrywall.com`) and `TRACKING_LINK_SECRET`, the same secret the storefront checks links with. Without them the email links to the carrier, and a warning is logged on each shipment.

`pnpm test` runs against an in-memory Postgres (PGlite) and needs no database.

## Signing in

Everyone shares one company account; each phone or computer signs in with its own passkey (Settings, then Devices). The dev server skips sign-in.

- `AUTH_ORIGIN` is the address katasync is opened at, e.g. `https://katasync.example.com`. Passkeys belong to that address, so changing it means adding every device again.
- `pnpm auth:setup-link` prints a one-time link for adding a device: the first one, or when every device has lost its passkey.

## Label printing

Labels print through QZ Tray on each packing computer. katasync makes its own QZ certificate the first time it's needed and keeps it in the database (`src/printing/qz.ts`). Settings, then Label printing, downloads a Windows script with that certificate in it: it installs QZ Tray 2.3.0 if it's missing or older (checked by hash), makes it trust katasync, turns off the QZ features katasync doesn't use, and restarts it. Run it again after reinstalling QZ Tray. The server only signs QZ requests that list printers or print a PDF to a named printer.

The dev server doesn't sign QZ requests or hand out the setup script, since it skips sign-in and its database may hold a copy of production's key. To print from dev, set `QZ_DEV_PRINTING=1`: it then uses a certificate of its own in `.qz-dev-certificate.json`, so a computer set up from dev trusts only dev.

**Replacing the certificate**, if the key may have leaked (a database copy, backup, or Neon branch got out, or someone with database access left): run `delete from qz_certificate` on the production database, then run the setup script from Settings again on every packing computer. The next print makes a new key; the script puts the new certificate in place of the old one, so QZ stops trusting the old key. Copies of the old key in older branches and backups are useless after that. Until a computer is set up again, its prints fail.

Each computer then picks its label printer in Settings; the choice is kept in that browser. Labels (4x6 PDFs from Shippo and TikTok) go straight to it, signed by the server (`src/server/printing.ts`, `src/printing/qz-client.ts`). The saved printer name must match an installed printer exactly; a renamed or missing printer is never silently replaced. Without a printer picked, labels open as PDFs in a new tab, as on phones. A failed print says why and offers the PDF. Use Test print on the packing computer to verify its Windows setup, driver, and physical 4x6 output.

## Buyer messages and AI replies

The Inbox's Buyers folder answers Amazon and eBay buyers in place (`src/buyers`). Amazon's messages come from the marketplaces mailbox and replies go through Resend from `MARKETPLACE_INBOX` (or `BUYER_REPLY_FROM`), which must be an approved sender in Seller Central. eBay's need the `commerce.message` scope: run `pnpm ebay:authorize` once.

An agent drafts a suggested reply for each thread waiting on us, following the Precedents folder (when this, then that), and reads buyers' messages into English (`src/ai`). It calls models through a CLIProxyAPI: set `AI_PROXY_URL`, `AI_PROXY_KEY`, and optionally `AI_MODEL` (default `claude-sonnet-5-5`). The proxy must be reachable from Vercel. Without them, everything else works and nothing is drafted.

Suppliers' emails that don't file themselves on a PO go to the same agent after each inbox run (`src/purchasing/inbox/ai-filing.ts`), up to two weeks old. When it's sure which PO an email is about, it files it there, follows its tracking numbers, and flags what the email says differs from the PO: a price, a quantity, a line back-ordered, or anything else in a note (`src/purchasing/flags.ts`). It changes no line itself: staff apply or dismiss each flag on the email or the PO page, and either can be undone. When it isn't sure, the PO shows on the email as a suggestion, one click to take. Undo on the email takes it off its PO with its tracking and open flags. Claude sees open flags in `get_purchase_order`, raises them with `flag_po`, and settles them with `resolve_po_flag`.

## Claude (MCP)

`/mcp` is an MCP server (Streamable HTTP, stateless) for Claude and other MCP clients, signed in with OAuth (`src/auth/oauth.ts`). Settings shows the address to add as a custom connector (or the `claude mcp add` command); the client registers itself and opens `/oauth/authorize`, where a signed-in device approves it as read only or able to make changes. Connected apps are listed in Settings and can be disconnected there. Claude can read anything (including read-only SQL), draft POs, receive sent ones, change products and the setup, count stock, ask staff for cycle counts, and build kits; an app approved read only gets only the reading tools. Every change it makes is listed on Diagnostics. Sending POs and buying labels stay in the app. Tools live in `src/mcp/server.ts`; the counting rules they rely on are the `owned_stock` and `sales_units` views.

## Schema changes

Edit `src/db/schema.ts`, then `pnpm db:generate` and commit the new file in `drizzle/`. For SQL that Drizzle can't express (triggers, functions), use `pnpm db:generate --custom --name <name>`.

Production deploys apply pending migrations before building (`scripts/vercel-build.sh`); a migration that fails stops the deploy. Previews never migrate, since they share the live database. The old deploy serves against the new schema while the build runs, so migrations must be additive. One that drops or renames something live code uses needs a coordinated cutover like the one below.

The dispatch cutover (`0031` through `0035`) requires a coordinated deployment. Back up the database first, stop old packing and sync processes, apply migrations using the direct connection, then deploy the dispatch-aware app before resuming work. `0033` removes the old shipment order and handoff columns after copying their data into dispatches; an old app cannot safely use that schema. A rollback requires restoring both the database and app, not just reverting the code.

## Backups and recovery

Recovery steps, including the attachment bytes stored in the database and how to rehearse a restore, are in [docs/disaster-recovery.md](docs/disaster-recovery.md). Neon's point-in-time history is not a portable copy, and the runbook lists what the operator must verify.

## Inventory model

- **Locations** are `owned` (we pick from them) or `fba` (Amazon's stock, mirrored read-only).
- **Products** are the canonical record for one SKU: name, image, barcode, cost, weight, and box size. Each is `simple`, `kit` (pre-assembled, has its own stock), or `bundle` (virtual, availability comes from components). Kits hold simple products; bundles hold simple products or kits.
- **Product groups** collect variants (e.g. one flat box in several sizes) for display. Stock and listings work on individual products.
- **Movements** are the append-only ledger. The database rejects edits and deletes; fix mistakes with a new movement.
- **Stock levels** are the running balance of movements per SKU and location, updated in the same transaction. They can go negative when a channel oversells.

- **Stores** are connected seller accounts (a channel plus a name). **Listings** are what each store sells, each mapped to one product. A multi-pack is a bundle product. FBA listings must map to a simple product or kit, since Amazon stocks physical units.

All stock changes go through `src/inventory/ledger.ts`. Mapping rules live in `src/channels/listings.ts`.

Returns are received only after an order is fully shipped. Partially shipped orders do not yet have per-line shipped counts, so receiving their returns is blocked rather than restocking units still awaiting shipment. Bundle returns use the components recorded in the original sale, not the current recipe; historical bundles without a recorded sale must have their returned parts counted individually.
