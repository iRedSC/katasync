import { type } from "arktype";

// Shippo buys labels for orders whose marketplace doesn't sell its own
// (Shopify web, POS, draft orders, and eBay).
const API = "https://api.goshippo.com";

function apiKey() {
	const key = process.env.SHIPPO_API_KEY;
	if (!key) throw new Error("Set SHIPPO_API_KEY to buy labels");
	return key;
}

// A test key buys sample labels: realistic, never charged, can't ship.
export function shippoIsTest() {
	return apiKey().startsWith("shippo_test_");
}

export type Address = {
	name: string;
	company?: string | null;
	street1: string;
	street2?: string | null;
	city: string;
	state: string;
	zip: string;
	country: string;
	phone?: string | null;
	email?: string | null;
};

export type Parcel = {
	lengthMm: number;
	widthMm: number;
	heightMm: number;
	weightGrams: number;
};

const MM_PER_INCH = 25.4;
const GRAMS_PER_OUNCE = 28.349523125;

// Shippo takes inches and ounces; katasync stores millimeters and grams.
export function toShippoParcel(p: Parcel) {
	const inches = (mm: number) => (mm / MM_PER_INCH).toFixed(2);
	return {
		length: inches(p.lengthMm),
		width: inches(p.widthMm),
		height: inches(p.heightMm),
		distance_unit: "in",
		weight: (p.weightGrams / GRAMS_PER_OUNCE).toFixed(2),
		mass_unit: "oz",
	};
}

async function shippo(path: string, body: unknown): Promise<unknown> {
	const response = await fetch(`${API}${path}`, {
		method: "POST",
		headers: {
			Authorization: `ShippoToken ${apiKey()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const json = await response.json();
	if (!response.ok) {
		throw new Error(
			`Shippo answered ${response.status}: ${JSON.stringify(json)}`,
		);
	}
	return json;
}

async function shippoGet(path: string): Promise<unknown> {
	const response = await fetch(`${API}${path}`, {
		headers: { Authorization: `ShippoToken ${apiKey()}` },
	});
	if (!response.ok) {
		throw new Error(
			`Shippo answered ${response.status}: ${await response.text()}`,
		);
	}
	return response.json();
}

const message = type({ "text?": "string" });

const shipmentResponse = type({
	object_id: "string",
	rates: type({
		object_id: "string",
		amount: "string.numeric.parse",
		provider: "string",
		servicelevel: { name: "string", token: "string" },
		"estimated_days?": "number | null",
	}).array(),
	"messages?": message.array(),
});

export type Rate = {
	id: string;
	carrier: string;
	service: string;
	serviceName: string;
	cost: number;
	days: number | null;
};

// Asks every connected carrier for a price. Rates are only good for a while,
// so they're fetched right before buying.
export async function getRates(input: {
	from: Address;
	to: Address;
	parcel: Parcel;
	insureAmount: number | null;
	signature: boolean;
}): Promise<{ rates: Rate[]; notes: string[] }> {
	const extra = {
		...(input.insureAmount && {
			insurance: {
				amount: input.insureAmount.toFixed(2),
				currency: "USD",
				content: "Tools",
			},
		}),
		...(input.signature && { signature_confirmation: "STANDARD" }),
	};
	const body = shipmentResponse.assert(
		await shippo("/shipments/", {
			address_from: input.from,
			address_to: input.to,
			parcels: [toShippoParcel(input.parcel)],
			// What insurance and a signature cost is in each rate's amount.
			extra: Object.keys(extra).length > 0 ? extra : undefined,
			async: false,
		}),
	);
	return {
		rates: body.rates.map((r) => ({
			id: r.object_id,
			carrier: r.provider,
			service: r.servicelevel.token,
			serviceName: `${r.provider} ${r.servicelevel.name}`,
			cost: r.amount,
			days: r.estimated_days ?? null,
		})),
		// When no rates come back, Shippo says why (a bad address, say).
		notes: (body.messages ?? []).flatMap((m) => (m.text ? [m.text] : [])),
	};
}

const rateResponse = type({
	object_id: "string",
	amount: "string.numeric.parse",
	provider: "string",
	carrier_account: "string",
	servicelevel: { name: "string", token: "string" },
	"estimated_days?": "number | null",
});

const carrierAccountResponse = type({ carrier: "string" });

// Reads a rate back from Shippo, so what gets recorded is what Shippo will
// charge, not whatever the browser sent.
export async function getRate(
	rateId: string,
): Promise<Rate & { carrierToken: string }> {
	const r = rateResponse.assert(
		await shippoGet(`/rates/${encodeURIComponent(rateId)}`),
	);
	// The rate only names the carrier for display ("USPS"); the token
	// Shippo's tracking API takes ("usps") is on the carrier account.
	const account = carrierAccountResponse.assert(
		await shippoGet(
			`/carrier_accounts/${encodeURIComponent(r.carrier_account)}`,
		),
	);
	return {
		id: r.object_id,
		carrier: r.provider,
		carrierToken: account.carrier,
		service: r.servicelevel.token,
		serviceName: `${r.provider} ${r.servicelevel.name}`,
		cost: r.amount,
		days: r.estimated_days ?? null,
	};
}

const transactionResponse = type({
	object_id: "string",
	status: "string",
	"label_url?": "string | null",
	"tracking_number?": "string | null",
	"tracking_url_provider?": "string | null",
	"messages?": message.array(),
});

// Buys the label for a rate. This is the step that costs money with a live
// key.
export async function buyLabel(rateId: string) {
	const body = transactionResponse.assert(
		await shippo("/transactions/", {
			rate: rateId,
			label_file_type: "PDF_4x6",
			async: false,
		}),
	);
	if (body.status !== "SUCCESS" || !body.label_url) {
		const why = (body.messages ?? []).flatMap((m) => (m.text ? [m.text] : []));
		throw new Error(`Label not bought: ${why.join("; ") || body.status}`);
	}
	return {
		id: body.object_id,
		labelUrl: body.label_url,
		trackingNumber: body.tracking_number ?? null,
		trackingUrl: body.tracking_url_provider || null,
	};
}

const refundResponse = type({ object_id: "string", status: "string" });

// Asks for a label's postage back. QUEUED or PENDING means Shippo accepted
// it and the carrier decides (USPS takes days); ERROR means no refund, say
// because the label was already scanned.
export async function refundLabel(transactionId: string) {
	const body = refundResponse.assert(
		await shippo("/refunds/", { transaction: transactionId, async: false }),
	);
	if (body.status === "ERROR") {
		throw new Error(
			"Shippo refused the refund; the label may already be in use",
		);
	}
	return { status: body.status };
}
