// Parsing for eBay Finances API transactions. Pure: no network, no database.
// Fetching is injected through fetchPage so paging can be tested.

export type EbayAmount = {
	value?: string | number | null;
	currency?: string | null;
	convertedFromCurrency?: string | null;
	convertedFromValue?: string | number | null;
	exchangeRate?: string | number | null;
};

export type EbayFee = {
	feeType?: string | null;
	amount?: EbayAmount;
};

export type EbayTransactionReference = {
	referenceType?: string | null;
	referenceId?: string | null;
};

export type EbayTransactionLineItem = {
	lineItemId?: string | null;
	marketplaceFees?: EbayFee[] | null;
};

export type EbayTransaction = {
	orderId?: string | null;
	transactionId?: string | null;
	transactionType?: string | null;
	transactionDate?: string | number | null;
	transactionMemo?: string | null;
	amount?: EbayAmount;
	totalFeeAmount?: EbayAmount;
	insuranceAmount?: EbayAmount;
	feeJurisdiction?: string | number | boolean | Record<string, never> | null;
	references?: EbayTransactionReference[] | null;
	fees?: EbayFee[] | null;
	orderLineItems?: EbayTransactionLineItem[] | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Which fields survive parsing. eBay adds fields without notice, and only the
// ones listed here reach the rest of the app. ObjectShape makes every key of
// the type appear here, so a field can't be added to the type and silently
// dropped.
type Shape = "scalar" | { fields: Record<string, Shape> } | { items: Shape };

type ObjectShape<T> = { fields: { [K in keyof T]-?: Shape } };

const amountShape = {
	fields: {
		value: "scalar",
		currency: "scalar",
		convertedFromCurrency: "scalar",
		convertedFromValue: "scalar",
		exchangeRate: "scalar",
	},
} satisfies ObjectShape<EbayAmount>;

const referenceShape = {
	fields: { referenceType: "scalar", referenceId: "scalar" },
} satisfies ObjectShape<EbayTransactionReference>;

const feeShape = {
	fields: { feeType: "scalar", amount: amountShape },
} satisfies ObjectShape<EbayFee>;

const lineItemShape = {
	fields: {
		lineItemId: "scalar",
		marketplaceFees: { items: feeShape },
	},
} satisfies ObjectShape<EbayTransactionLineItem>;

const transactionShape = {
	fields: {
		orderId: "scalar",
		transactionId: "scalar",
		transactionType: "scalar",
		transactionDate: "scalar",
		transactionMemo: "scalar",
		amount: amountShape,
		totalFeeAmount: amountShape,
		insuranceAmount: amountShape,
		// Kept as an empty object: no fields of it were ever declared.
		feeJurisdiction: { fields: {} },
		references: { items: referenceShape },
		fees: { items: feeShape },
		orderLineItems: { items: lineItemShape },
	},
} satisfies ObjectShape<EbayTransaction>;

function pick(value: unknown, shape: Shape): unknown {
	if (value === undefined || value === null || shape === "scalar") {
		return value;
	}
	if ("items" in shape) {
		return Array.isArray(value)
			? value.map((item) => pick(item, shape.items))
			: value;
	}
	if (!isRecord(value)) return value;
	const picked: Record<string, unknown> = {};
	for (const [key, fieldShape] of Object.entries(shape.fields)) {
		if (!Object.hasOwn(value, key)) continue;
		picked[key] = pick(value[key], fieldShape);
	}
	return picked;
}

export function parseEbayAmount(amount: unknown): number {
	if (!isRecord(amount)) {
		return parseFloat("0");
	}
	const value = amount.value;
	if (typeof value === "string") {
		return parseFloat(value || "0");
	}
	if (typeof value === "number") {
		return parseFloat(String(value || "0"));
	}
	if (typeof value === "boolean" || typeof value === "bigint") {
		return parseFloat(String(value));
	}
	if (!value) {
		return parseFloat("0");
	}
	return Number.NaN;
}

export function transactionBelongsToOrder(
	transaction: { orderId?: unknown; references?: unknown },
	orderId: string,
): boolean {
	return getEbayTransactionOrderIds(transaction).includes(orderId);
}

// Some transactions (such as ad fees) name their order only in references,
// so both places count.
export function getEbayTransactionOrderIds(transaction: {
	orderId?: unknown;
	references?: unknown;
}): string[] {
	const orderIds = new Set<string>();
	if (typeof transaction.orderId === "string") {
		orderIds.add(transaction.orderId);
	}
	if (transaction.references && Array.isArray(transaction.references)) {
		for (const reference of transaction.references) {
			if (
				isRecord(reference) &&
				reference.referenceType === "ORDER_ID" &&
				typeof reference.referenceId === "string"
			) {
				orderIds.add(reference.referenceId);
			}
		}
	}
	return [...orderIds];
}

export function toEbayTransactions(value: unknown): EbayTransaction[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const transactions: EbayTransaction[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		// pick returns a record for a record input, and transactionShape
		// lists every EbayTransaction key, so the cast holds.
		transactions.push(pick(item, transactionShape) as EbayTransaction);
	}
	return transactions;
}

export function readEbayTransactionsPage(data: unknown): {
	rawPage: unknown[];
	transactions: EbayTransaction[];
} {
	const raw = isRecord(data) ? data.transactions : undefined;
	const rawPage = Array.isArray(raw) ? raw : [];
	return { rawPage, transactions: toEbayTransactions(rawPage) };
}

type CollectEbayTransactionPagesArgs = {
	limit: number;
	fetchPage: (args: { offset: number; limit: number }) => Promise<unknown>;
};

// A short or empty page means the last one.
export async function collectEbayTransactionPages({
	limit,
	fetchPage,
}: CollectEbayTransactionPagesArgs): Promise<EbayTransaction[]> {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error(
			`eBay page size must be a whole number above 0, not ${limit}`,
		);
	}
	const transactions: EbayTransaction[] = [];

	for (let offset = 0; ; offset += limit) {
		const page = readEbayTransactionsPage(await fetchPage({ offset, limit }));
		transactions.push(...page.transactions);
		if (page.rawPage.length === 0 || page.rawPage.length < limit) {
			return transactions;
		}
	}
}
