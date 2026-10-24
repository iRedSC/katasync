# Committed stock: activation runbook

Migration `0121_quantity_commitments` is additive and leaves
`quantity_mode` at `legacy`. In legacy mode everything behaves as before:
orders take stock when they sync (net stock). Nothing switches modes on its own.

Committed mode means shelves hold physical units, unshipped orders reserve
(`committed_stock`), and stock leaves the shelf only when a dispatch hands
`consumeCommitments` exact shipped line quantities.

## Preconditions

1. The deploy carrying the quantity migration is live and is the only one
   serving. Old deployments run legacy ingest that ignores the mode row, so
   they must be gone: promote, then confirm no older deployment still runs
   crons, webhooks, or syncs.
2. Pause order sync, webhooks, and quick ship for the window (the job that
   calls `ingestOrder`, `reconcileStock`, and shipping handoff).
3. Migration `0122_quantity_dispatch_evidence` and the complete shipping,
   reconciliation, and actor-attribution integration are deployed. Packed
   dispatches from before that migration have no frozen inventory line ID
   and are held in committed mode. Resolve or void and repack them before
   activation; do not reconstruct historical IDs from today's order lines.
4. Take and verify an isolated recoverable database branch before activation.
   There is no in-app mode reversal. Follow `docs/disaster-recovery.md` for
   recovery handling if that runbook is deployed.

## Dry run (read-only)

    pnpm tsx scripts/activate-committed-stock.ts

It prints the lines it would convert, the lines it keeps as sold (POS and
fully shipped), every unresolved line, committed drift, and a fingerprint.
Exit code 2 means unresolved lines block activation.

## Resolving lines

An unresolved line is one where katasync can't tell how much physically
left: partly fulfilled orders, labels bought on orders the channel still
calls unfulfilled, unknown statuses, cancelled orders whose sale wasn't
undone, channel-fulfilled orders with a sale, and sale batches that don't
divide evenly by the line quantity. Check each one on the shelf or the
channel, then write what actually shipped:

    [{ "orderLineId": 123, "shipped": 2 }]

`shipped` equal to the quantity keeps the sale. Anything less reverses the
eager sale, reserves the line, and records the shipped part as a dispatch.
Lines that can only be kept (cancelled, channel-fulfilled, uneven batches)
take only the full quantity. Rerun the dry run with
`--resolutions file.json` until nothing is unresolved.

## Activate

    pnpm tsx scripts/activate-committed-stock.ts --resolutions file.json \
      --write --old-workers-drained --fingerprint <from the dry run>

One transaction: it locks the mode row, recomputes the plan, refuses if the
fingerprint changed, undoes each open eager sale batch with its own cost
reversal (order line unit costs are never touched), reserves the same frozen
parts, and then checks that physical minus committed is unchanged per product,
that every converted line has exactly its unshipped quantity reserved, and
that `committed_stock` matches the commitment history. Any failure rolls the
whole thing back.

## After

Resume sync and shipping. The UI drops the "net, pending activation" marker.
There is no automatic way back; reverting means restoring a database branch
taken right before activation.
