# Marketplace obligations

`open_cases` unifies unresolved return requests and `marketplace_cases`. Its key is `(source, id)`, not `id` alone. Marketplace cases keep a nullable order link and the source order reference. Importing an order later lets the next case read attach it. Never inner join orders when counting obligations.

The eBay returns cron reads Post-Order inquiries, cancellations from both buyer and seller initiators, escalations, and Fulfillment payment disputes. Imports are read-only. OAuth token refresh is the only POST used by these readers.

## Source states

| Source | Raw states | Status | Waiting on |
| --- | --- | --- | --- |
| Inquiry | OPEN, WAITING_SELLER_RESPONSE | open | us |
| Inquiry | WAITING_BUYER_RESPONSE | open | buyer |
| Inquiry | PENDING | processing | marketplace |
| Inquiry | CLOSED, CS_CLOSED, CLOSED_WITH_ESCALATION | closed | nobody |
| Cancellation | APPROVAL_PENDING | open | us |
| Cancellation | CONFIRM_REFUND_PENDING | processing | buyer |
| Cancellation | REFUND_FAILED_RETRY, REFUND_INITIATED, REFUND_PENDING | processing | marketplace |
| Cancellation | CLOSED | closed | nobody |
| Escalation | OPEN | open | marketplace |
| Escalation | ON_HOLD, WAITING_CS, WAITING_DELIVERY | processing | marketplace |
| Escalation | REFUND_AGREED_BUT_FAILED | processing | us |
| Escalation | CLOSED, CS_CLOSED | closed | nobody |
| Dispute | ACTION_NEEDED | open | us |
| Dispute | OPEN | processing | marketplace |
| Dispute | CLOSED | closed | nobody |
| Any | Unrecognized, OTHER; cancellation INITIAL | unknown | marketplace |

Current seller choices, requested evidence, or an exact seller deadline establish seller ownership unless the source explicitly says buyer or resolved. Unknown statuses remain unknown and produce feed problems even when seller action is established. Escalations carry `in_progress` until closed.

Deadlines come only from eBay: inquiry `sellerMakeItRightByDate` or search `respondByDate`, cancellation `sellerResponseDueDate`, escalation search `respondByDate`, dispute `respondByDate` and evidence deadlines, return detail `sellerResponseDue.respondByDate`. Multiple supplied deadlines use the earliest. Buyer and resolved states clear seller deadlines. Missing deadlines stay null. No duration is converted into a guessed deadline.

Case links use a supplied browser action URL when present, otherwise the existing eBay order link for matched orders. API mutation URLs are not browser links. Orderless cases with no supplied URL remain visible with their case ID, without a fabricated deep link.

## Coverage and consent

The `cases` and `disputes` feeds have separate coverage and health so missing dispute consent does not stop Post-Order discovery. Discovery starts 60 days back, uses seven-day windows with a one-day overlap, and rereads saved unresolved cases. Completed windows survive an interrupted catch-up. History beyond eBay's 18-month reach stays an explicit unread gap. Detail errors cannot produce a clean feed. All feeds share the existing returns pass budget.

Disputes request `https://api.ebay.com/oauth/api_scope/sell.payment.dispute` separately from normal sync scopes. Missing consent records **Needs eBay re-authorization**. The feed stops refreshing that same credential until its fingerprint changes, while other feeds continue.

The owner runs `pnpm ebay:authorize`, replaces the deployed `EBAY_REFRESH_TOKEN` with the newly consented token, and redeploys. Never paste the token into a PR or chat. The next pass retries automatically.

## Production verification

On October 26, 2026, one GET to `/post-order/v2/inquiry/search?limit=1&offset=1` with the existing OAuth user token and the `IAF` header returned HTTP 200, with `members`, `totalNumberOfInquiries`, and `paginationOutput`. The refresh request and this single inquiry GET changed no marketplace data.

Production cancellation, escalation, return-detail and dispute responses have not been exercised. Their requests, pagination, detail handling, state mappings, authorization recovery and persistence have local fixture tests. Browser behavior has not been exercised. Migrations are generated and tested only in disposable PGlite databases, never applied to a real database during implementation.

Primary API references: the eBay Post-Order `searchInquiries`, `getInquiry`, `findCancelRequests`, `getCancelDetail`, `searchCases`, `getCase`, and `getReturn` reference pages, and the official Fulfillment OpenAPI document at `https://developer.ebay.com/api-docs/master/sell/fulfillment/openapi/3/sell_fulfillment_v1_oas3.json`.
