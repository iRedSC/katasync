# Marketplace stock writes are blocked

This release reads marketplace inventory and calculates differences. It does not send stock quantities to Shopify, eBay, TikTok Shop, or Amazon, including zero. Existing stock-push opt-ins show **Blocked**, cannot be enabled, and can be turned off. There is no zero-containment request or automatic synchronization to acknowledge.

Keep the existing inventory service in place if it supplies marketplace stock. Do not turn that service off expecting this release to replace it. Listing imports, order ingestion, commitments, local stock movements and transfer receiving continue independently of this restriction.

## What prevents writes

The channel interface exposes only reads. The stock adapters contain no inventory mutation implementations, and the planner accepts only preview mode. An old caller passing write mode is refused at runtime before any channel request. Both the server and MCP contracts accept disabling only.

The planner preserves availability, close-at, bundle and retail-reserve calculations. Differences are explicitly blocked proposals. Cached `shows` values remain observations, never optimistic write acknowledgements. Neither quantity equality nor an old successful-push timestamp produces a synchronized or healthy state. The preview script can refresh observations for a disabled store without enabling it.

## Why an absolute replacement is unsafe

Suppose the last observed remote stock was 10 and the local target is 9. A marketplace sale can reduce remote stock to 7 before the replacement arrives. Setting 9 restores two already-sold units. Retrying the same absolute replacement can do the same thing after an earlier request succeeded. A local lock, completed ingestion pass, elapsed time, or another remote read does not close this race.

Even zero is not implemented as an escape hatch: zero eligibility and effective closure differ by channel. An accepted asynchronous request is not proof of closure. No existing opt-in is silently converted into a different containment operation.

## Deployment boundary

Drain old workers and in-flight stock-push requests before deploying the restriction. New code cannot recall a positive request sent by an older process, and cannot control a different external inventory writer. This release makes no claim of globally oversell-free inventory.

## Requirements for future delivery

Positive delivery needs a separate audited bootstrap and cutover, durable independently justified availability deltas, source-event deduplication, exact native destination and relay-effect suppression, and explicit unknown-outcome recovery. A source event missing from ingestion remains missing; an outbox alone cannot prove source completeness.

Shopify has documented conditional-relative adjustment and bounded idempotency contracts that may support such a delivery system. That system is not implemented here. The current eBay, TikTok and Amazon endpoints have no verified equivalent contract for this design. Unsupported destinations must remain blocked rather than fall back to read-subtract-set.

Any future implementation must distinguish proposed, blocked, submitted, accepted, observed and effective outcomes, persist exact retry identities and payloads, and stop uncertain retries when the provider's deduplication guarantee expires.
