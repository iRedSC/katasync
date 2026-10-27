import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { senderAuthenticated } from "#/inbox/sender-auth";
import {
	type BuyerEmail,
	type BuyerOrderRef,
	matchShopifyReply,
	newReplyToken,
	readThreadAddress,
	replyText,
	type ShopifyThreadRef,
	threadAddress,
} from "./shopify-match";

const BUYER = "pat@example.com";
const INBOX = "marketplaces@eastcoastdrywall.com";

beforeEach(() => {
	vi.stubEnv("MARKETPLACE_INBOX", INBOX);
});
afterEach(() => vi.unstubAllEnvs());

const at = new Date(Date.UTC(2026, 9, 1));
// Each thread's token, as random as the real ones.
const token = (id: number) => `5e7c0a${id}`.padEnd(16, "f");
const thread = (id: number, orderName: string, open = true) =>
	({
		id,
		replyToken: token(id),
		email: BUYER,
		orderName,
		open,
		createdAt: at,
	}) satisfies ShopifyThreadRef;
const mail = (over: Partial<BuyerEmail> = {}): BuyerEmail => ({
	fromAddress: BUYER,
	senderAuthenticated: true,
	recipients: [INBOX],
	subject: "Hello",
	body: "",
	receivedAt: new Date(Date.UTC(2026, 9, 2)),
	...over,
});
const two = [thread(1, "#5536"), thread(2, "#5537")];
// Pat's orders: both threaded, and #9999 with no conversation yet.
const orders: BuyerOrderRef[] = ["#5536", "#5537", "#9999"].map((name) => ({
	email: BUYER,
	name,
}));
const match = (m: BuyerEmail, threads = two) =>
	matchShopifyReply(m, threads, orders);
const to = (id: number) => threadAddress(token(id)) ?? "";

describe("thread addresses", () => {
	test("carry a random token, read back as it was", () => {
		const a = newReplyToken();
		expect(a).toMatch(/^[0-9a-f]{16}$/);
		expect(newReplyToken()).not.toBe(a);
		expect(threadAddress(a)).toBe(`marketplaces+so${a}@eastcoastdrywall.com`);
		expect(readThreadAddress(threadAddress(a) ?? "")).toEqual({
			kind: "token",
			token: a,
		});
		expect(readThreadAddress(INBOX).kind).toBe("other");
	});
});

describe("matching a buyer's email to a thread", () => {
	test("its one signed thread address wins", () => {
		expect(match(mail({ recipients: [to(2)] }))).toEqual({
			threadId: 2,
			by: "address",
		});
	});

	test("a tampered thread address doesn't match, even beside a good one", () => {
		// One character off: a token no thread has.
		const bad = to(2).replace(`${token(2)}@`, `${token(2).slice(0, -1)}0@`);
		expect(match(mail({ recipients: [bad] })).threadId).toBeNull();
		expect(match(mail({ recipients: [to(2), bad] })).threadId).toBeNull();
	});

	test("two thread addresses, or one that's another buyer's, don't match", () => {
		const sams = { ...thread(3, "#5538"), email: "sam@example.com" };
		expect(match(mail({ recipients: [to(1), to(2)] })).threadId).toBeNull();
		expect(
			match(mail({ recipients: [to(2), to(3)] }), [...two, sams]).threadId,
		).toBeNull();
		expect(
			match(mail({ recipients: [to(3)] }), [...two, sams]).threadId,
		).toBeNull();
	});

	test("falls back to the one order it names, never a longer number", () => {
		expect(match(mail({ subject: "Re: Your order #5537" }))).toEqual({
			threadId: 2,
			by: "order",
		});
		expect(
			match(mail({ subject: "Re: Your order #55370" })).threadId,
		).toBeNull();
	});

	test("an order with no conversation, or not theirs, isn't filed by sender", () => {
		const one = [thread(1, "#5536")];
		expect(match(mail({ body: "Cancel order #9999" }), one)).toMatchObject({
			threadId: null,
			why: "#9999 has no conversation yet",
		});
		expect(match(mail({ body: "Where is #4242?" }), one).threadId).toBeNull();
	});

	test("its address and the order it names must agree", () => {
		expect(
			match(mail({ recipients: [to(1)], subject: "About #5537" })).threadId,
		).toBeNull();
		expect(
			match(mail({ recipients: [to(1)], subject: "Re: Your order #5536" })),
		).toEqual({ threadId: 1, by: "address" });
	});

	test("only their own words name an order, not what they quote or forward", () => {
		const one = [thread(1, "#5536")];
		expect(
			match(
				mail({
					recipients: [to(1)],
					body: "See below.\n\n---------- Forwarded message ---------\nFrom: shop\nYour order #5537 shipped",
				}),
			),
		).toEqual({ threadId: 1, by: "address" });
		// The quote alone names #5537; their one open thread is #5536's.
		expect(
			match(mail({ body: "Yes please\n> Your order #5537 is ready" }), one),
		).toEqual({ threadId: 1, by: "sender" });
		expect(
			match(mail({ body: "Thanks\n\nOn Mon, Oct 5 ECDT wrote:\n#5537" }))
				.threadId,
		).toBeNull();
	});

	test("two orders named, or two open threads, is left unmatched", () => {
		expect(match(mail({ body: "About #5536 and #5537" })).threadId).toBeNull();
		expect(match(mail()).threadId).toBeNull();
	});

	test("their one open thread takes what names nothing", () => {
		expect(
			match(mail(), [thread(1, "#5536"), thread(2, "#5537", false)]),
		).toEqual({
			threadId: 1,
			by: "sender",
		});
	});

	test("an unverified sender, mail from before the thread, or someone else's, isn't an answer", () => {
		const one = [thread(1, "#5536")];
		expect(
			match(mail({ senderAuthenticated: false, recipients: [to(1)] }), one)
				.threadId,
		).toBeNull();
		expect(
			match(mail({ receivedAt: new Date(Date.UTC(2026, 8, 1)) }), one).threadId,
		).toBeNull();
		expect(
			match(mail({ fromAddress: "sam@example.com" }), one).threadId,
		).toBeNull();
	});

	test("keeps their words above the quoted email", () => {
		expect(
			replyText(
				"Yes please.\r\n\r\nOn Mon, Oct 5, 2026 at 9:00 AM ECDT <x@y.com> wrote:\r\n> Your order",
			),
		).toBe("Yes please.");
		expect(replyText("Just this")).toBe("Just this");
	});
});

describe("whether Microsoft vouched for the sender", () => {
	const results = (value: string) => [
		{ name: "Authentication-Results", value },
	];
	test("DMARC, or SPF or DKIM aligned to the From domain, passing", () => {
		expect(
			senderAuthenticated(
				results(
					"spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100",
				),
				BUYER,
			),
		).toBe(true);
		expect(
			senderAuthenticated(results("dmarc=pass header.from=example.com"), BUYER),
		).toBe(true);
	});

	test("SPF or DKIM aligned to the From domain without DMARC", () => {
		expect(
			senderAuthenticated(
				results(
					"spf=pass smtp.mailfrom=bounce.example.com;dmarc=none;compauth=pass reason=109",
				),
				BUYER,
			),
		).toBe(true);
		expect(
			senderAuthenticated(
				results("spf=none;dkim=pass header.d=example.com;dmarc=none"),
				BUYER,
			),
		).toBe(true);
	});

	test("an implicit compauth pass without the From domain proven", () => {
		expect(
			senderAuthenticated(
				results(
					"spf=pass smtp.mailfrom=evil.test;dkim=none;dmarc=none;compauth=pass reason=103",
				),
				BUYER,
			),
		).toBe(false);
		expect(
			senderAuthenticated(
				results(
					"spf=fail smtp.mailfrom=example.com;dmarc=fail header.from=example.com;compauth=pass reason=104",
				),
				BUYER,
			),
		).toBe(false);
		// Aligned SPF can't outvote the domain's own DMARC failing.
		expect(
			senderAuthenticated(
				results(
					"spf=pass smtp.mailfrom=example.com;dmarc=fail header.from=example.com",
				),
				BUYER,
			),
		).toBe(false);
		// A lookalike isn't under the From domain.
		expect(
			senderAuthenticated(
				results("dkim=pass header.d=notexample.com;dmarc=none"),
				BUYER,
			),
		).toBe(false);
	});

	test("failing, another domain's DMARC, no header, or one under Microsoft's", () => {
		expect(
			senderAuthenticated(
				results("dmarc=fail header.from=example.com;compauth=fail reason=000"),
				BUYER,
			),
		).toBe(false);
		expect(
			senderAuthenticated(results("dmarc=pass header.from=evil.test"), BUYER),
		).toBe(false);
		expect(senderAuthenticated([], BUYER)).toBe(false);
		expect(
			senderAuthenticated(
				[
					{ name: "Authentication-Results", value: "compauth=fail reason=000" },
					// Written by the sender, below Microsoft's own.
					{ name: "Authentication-Results", value: "compauth=pass" },
				],
				BUYER,
			),
		).toBe(false);
	});
});
