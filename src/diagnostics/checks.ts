import { type } from "arktype";
import { accessToken as amazonAccessToken, spApi } from "#/channels/amazon-api";
import {
	API as EBAY_API,
	accessToken as ebayAccessToken,
} from "#/channels/ebay";
import { shopifyQuery } from "#/channels/shopify";
import { tiktokApi } from "#/channels/tiktok";
import {
	graphToken,
	INBOX_ENV,
	inboxAddress,
	newestMessageAt,
	tokenRoles,
} from "#/purchasing/inbox/graph";
import { errorText } from "./runs";

// Live, step-by-step checks of each outside service katasync depends on.
// Read-only apart from the token refresh a sync would do anyway. Server only.

// What each sync channel needs in the environment. scripts/sync.ts skips a
// channel missing any of these; Diagnostics shows it as not connected.
export const channelEnv = {
	shopify: ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN"],
	ebay: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN"],
	amazon: ["AMAZON_CLIENT_ID", "AMAZON_CLIENT_SECRET", "AMAZON_REFRESH_TOKEN"],
	tiktok: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN"],
} as const;

export type SyncedChannel = keyof typeof channelEnv;
export type CheckTarget = SyncedChannel | "shippo" | "email" | "inbox";

export const missingEnv = (names: readonly string[]) =>
	names.filter((name) => !process.env[name]);

export type CheckStep = {
	label: string;
	status: "ok" | "warn" | "fail";
	detail: string;
	ms: number;
};

// Runs steps in order and stops at the first failure, since later steps need
// earlier ones (no token, no API call). A step returns its detail, or
// { warn } to pass while flagging something, or throws to fail.
class Steps {
	done: CheckStep[] = [];
	private failed = false;

	async step(label: string, run: () => Promise<string | { warn: string }>) {
		if (this.failed) return;
		const started = Date.now();
		try {
			const result = await run();
			this.done.push({
				label,
				status: typeof result === "string" ? "ok" : "warn",
				detail: typeof result === "string" ? result : result.warn,
				ms: Date.now() - started,
			});
		} catch (error) {
			this.failed = true;
			this.done.push({
				label,
				status: "fail",
				detail: errorText(error),
				ms: Date.now() - started,
			});
		}
	}
}

function needEnv(s: Steps, names: readonly string[]) {
	return s.step("Credentials", async () => {
		const missing = missingEnv(names);
		if (missing.length > 0) throw new Error(`Set ${missing.join(", ")}`);
		return `${names.join(", ")} set`;
	});
}

const DAY = 86_400_000;

async function checkShopify(s: Steps) {
	await needEnv(s, channelEnv.shopify);
	await s.step("Log in (shop query)", async () => {
		const data = type({ shop: { name: "string" } }).assert(
			await shopifyQuery("{ shop { name } }", {}),
		);
		return `Token works for "${data.shop.name}"`;
	});
	await s.step("Granted scopes", async () => {
		const data = type({
			currentAppInstallation: {
				accessScopes: type({ handle: "string" }).array(),
			},
		}).assert(
			await shopifyQuery(
				"{ currentAppInstallation { accessScopes { handle } } }",
				{},
			),
		);
		const scopes = data.currentAppInstallation.accessScopes.map(
			(a) => a.handle,
		);
		// Reading orders and products is the sync; the rest is shipping and
		// repairs.
		const missing = ["read_orders", "read_products"].filter(
			(scope) => !scopes.includes(scope),
		);
		if (missing.length > 0)
			throw new Error(
				`Missing ${missing.join(", ")}. Granted: ${scopes.join(", ")}`,
			);
		const warnings = [
			!scopes.includes("read_all_orders") &&
				"no read_all_orders, so orders older than 60 days can't be read",
			!scopes.some((s) => s.includes("fulfillment")) &&
				"no fulfillment scope, so tracking can't be sent to Shopify",
			!scopes.includes("write_orders") &&
				"no write_orders, so the storefront tracking page can't get Shippo carriers",
			!scopes.includes("write_draft_orders") &&
				"no write_draft_orders, so repairs can't be billed",
			!scopes.includes("write_customers") &&
				"no write_customers, so repairs can't add customers",
		].filter(Boolean);
		const granted = `Granted: ${scopes.join(", ")}`;
		return warnings.length > 0
			? { warn: `${warnings.join("; ")}. ${granted}` }
			: granted;
	});
	await s.step("Latest order", async () => {
		const data = type({
			orders: {
				nodes: type({ name: "string", createdAt: "string" }).array(),
			},
		}).assert(
			await shopifyQuery(
				"{ orders(first: 1, reverse: true, sortKey: CREATED_AT) { nodes { name createdAt } } }",
				{},
			),
		);
		const order = data.orders.nodes[0];
		return order
			? `${order.name}, placed ${new Date(order.createdAt).toLocaleString()}`
			: { warn: "The store returned no orders" };
	});
}

async function checkEbay(s: Steps) {
	await needEnv(s, channelEnv.ebay);
	await s.step("Refresh token looks whole", async () => {
		// eBay's refresh tokens look like "v^1.1#i^1#...". An unquoted "#" in
		// .env starts a comment, leaving only "v^1.1".
		const token = process.env.EBAY_REFRESH_TOKEN ?? "";
		if (!token.includes("#") || token.length < 40)
			throw new Error(
				`EBAY_REFRESH_TOKEN is ${token.length} characters with no "#"; it was probably cut off. Quote it in .env.local.`,
			);
		return `${token.length} characters`;
	});
	let token = "";
	await s.step("Log in (refresh token)", async () => {
		token = await ebayAccessToken();
		return "Got an access token";
	});
	await s.step("Fulfillment API (orders, last 7 days)", async () => {
		const since = new Date(Date.now() - 7 * DAY).toISOString();
		const response = await fetch(
			`${EBAY_API}/sell/fulfillment/v1/order?limit=1&filter=${encodeURIComponent(`creationdate:[${since}..]`)}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		const text = await response.text();
		if (!response.ok)
			throw new Error(`eBay answered ${response.status}: ${text}`);
		const total = type({ "total?": "number" }).assert(JSON.parse(text)).total;
		return `${total ?? 0} orders placed`;
	});
}

async function checkAmazon(s: Steps) {
	await needEnv(s, channelEnv.amazon);
	await s.step("Log in (refresh token)", async () => {
		await amazonAccessToken();
		return "Got an access token";
	});
	// Cheap and not rate-limited like order lists, which the sync is using.
	await s.step("Seller account", async () => {
		const body = type({
			payload: type({
				marketplace: { id: "string", name: "string" },
				participation: { isParticipating: "boolean" },
			}).array(),
		}).assert(await spApi("/sellers/v1/marketplaceParticipations"));
		const us = body.payload.find((p) => p.marketplace.id === "ATVPDKIKX0DER");
		if (!us) throw new Error("This seller isn't in the US marketplace");
		return us.participation.isParticipating
			? `Selling on ${us.marketplace.name}`
			: { warn: `Not currently participating in ${us.marketplace.name}` };
	});
}

async function checkTiktok(s: Steps) {
	await needEnv(s, channelEnv.tiktok);
	// Signs in with the refresh token and lists the shops the app may use.
	await s.step("Authorized shops", async () => {
		const { shops } = type({
			shops: type({ name: "string", region: "string" }).array(),
		}).assert(await tiktokApi("/authorization/202309/shops", {}));
		const us = shops.find((shop) => shop.region === "US");
		if (!us) throw new Error("No US shop is authorized for this app");
		return us.name;
	});
}

async function checkShippo(s: Steps) {
	await needEnv(s, ["SHIPPO_API_KEY"]);
	await s.step("Key and carriers", async () => {
		const key = process.env.SHIPPO_API_KEY ?? "";
		const response = await fetch(
			"https://api.goshippo.com/carrier_accounts?results=25",
			{ headers: { Authorization: `ShippoToken ${key}` } },
		);
		const text = await response.text();
		if (!response.ok)
			throw new Error(`Shippo answered ${response.status}: ${text}`);
		const active = type({
			results: type({ carrier: "string", active: "boolean" }).array(),
		})
			.assert(JSON.parse(text))
			.results.filter((c) => c.active)
			.map((c) => c.carrier);
		const carriers =
			active.length > 0 ? [...new Set(active)].join(", ") : "none active";
		return key.startsWith("shippo_test_")
			? {
					warn: `Test key: labels are samples that can't ship. Carriers: ${carriers}`,
				}
			: `Live key. Carriers: ${carriers}`;
	});
}

async function checkEmail(s: Steps) {
	await needEnv(s, ["RESEND_API_KEY", "PO_EMAIL_FROM"]);
	await s.step("Sending domain", async () => {
		const from = process.env.PO_EMAIL_FROM ?? "";
		const domain = /@([^>\s]+)/.exec(from)?.[1];
		if (!domain)
			throw new Error(`PO_EMAIL_FROM "${from}" has no address in it`);
		const response = await fetch("https://api.resend.com/domains", {
			headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
		});
		const text = await response.text();
		// A sending-only key may not list domains; that's the safer key to use.
		if (response.status === 401 && /restricted/i.test(text))
			return {
				warn: `Send-only key, so ${domain} can't be checked.`,
			};
		if (!response.ok)
			throw new Error(`Resend answered ${response.status}: ${text}`);
		const found = type({
			data: type({ name: "string", status: "string" }).array(),
		})
			.assert(JSON.parse(text))
			.data.find((d) => d.name === domain);
		if (!found)
			throw new Error(`${domain} isn't a domain in this Resend account`);
		if (found.status !== "verified")
			throw new Error(`${domain} is ${found.status}, not verified, in Resend`);
		return `${domain} verified`;
	});
}

async function checkInbox(s: Steps) {
	await needEnv(s, INBOX_ENV);
	let token = "";
	await s.step("Sign in to Microsoft 365", async () => {
		token = await graphToken();
		return "Token issued";
	});
	await s.step("Limited to the purchasing mailbox", async () => {
		// Exchange scopes the app to one mailbox without a role in the token. A
		// Mail role here comes from Entra and reaches every mailbox.
		const broad = tokenRoles(token).filter((r) => /^Mail\./.test(r));
		if (broad.length > 0)
			throw new Error(
				`Entra grants ${broad.join(", ")}, which reads every mailbox in the company. Revoke its admin consent under App registrations, KataSync mail, API permissions.`,
			);
		return "No company-wide mail permission";
	});
	await s.step("Read the inbox", async () => {
		const newest = await newestMessageAt();
		return newest
			? `${inboxAddress()}: newest email ${newest.toISOString().slice(0, 16).replace("T", " ")} UTC`
			: `${inboxAddress()}: empty`;
	});
}

const checks: Record<CheckTarget, (s: Steps) => Promise<void>> = {
	shopify: checkShopify,
	ebay: checkEbay,
	amazon: checkAmazon,
	tiktok: checkTiktok,
	shippo: checkShippo,
	email: checkEmail,
	inbox: checkInbox,
};

export async function runCheck(target: CheckTarget) {
	const s = new Steps();
	await checks[target](s);
	return { steps: s.done, ranAt: new Date() };
}
