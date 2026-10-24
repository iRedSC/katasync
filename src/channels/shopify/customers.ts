import { type } from "arktype";
import { shopifyQuery, userErrors } from "./client";

// Customers live in Shopify; katasync finds, adds, and edits them there and
// keeps none of its own (repairs copy the name for the board).

const customerShape = type({
	id: "string",
	firstName: "string | null",
	lastName: "string | null",
	displayName: "string",
	defaultEmailAddress: type({ emailAddress: "string | null" }).or("null"),
	defaultPhoneNumber: type({ phoneNumber: "string" }).or("null"),
	numberOfOrders: "string | number",
	createdAt: "string",
});

const CUSTOMER_FIELDS = `id firstName lastName displayName
	defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }
	numberOfOrders createdAt`;

export type Customer = {
	id: string;
	firstName: string;
	lastName: string;
	name: string;
	email: string | null;
	phone: string | null;
	orders: number;
	createdAt: string;
};

const toCustomer = (c: typeof customerShape.infer): Customer => ({
	id: c.id,
	firstName: c.firstName ?? "",
	lastName: c.lastName ?? "",
	name: c.displayName,
	email: c.defaultEmailAddress?.emailAddress ?? null,
	phone: c.defaultPhoneNumber?.phoneNumber ?? null,
	orders: Number(c.numberOfOrders),
	createdAt: c.createdAt,
});

// Shopify's own search (name, email, phone). It finds a phone number by
// its digits only, so "(440) 272-5076" is searched as 4402725076. Empty
// lists the newest.
export function customerQuery(text: string) {
	const q = text.trim();
	if (!/^[\d\s()+.-]+$/.test(q)) return q;
	const digits = q.replace(/\D/g, "");
	// A US country code would keep it from matching.
	return digits.length === 11 && digits.startsWith("1")
		? digits.slice(1)
		: digits;
}

export async function searchCustomers(text: string, first = 25) {
	const data = type({
		customers: { nodes: customerShape.array() },
	}).assert(
		await shopifyQuery(
			`query($q: String, $first: Int!) { customers(first: $first, query: $q, sortKey: UPDATED_AT, reverse: true) { nodes { ${CUSTOMER_FIELDS} } } }`,
			{ q: customerQuery(text) || null, first },
		),
	);
	return data.customers.nodes.map(toCustomer);
}

export async function readCustomer(id: string) {
	const data = type({ customer: customerShape.or("null") }).assert(
		await shopifyQuery(
			`query($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} } }`,
			{ id },
		),
	);
	return data.customer && toCustomer(data.customer);
}

export type CustomerFields = {
	firstName: string;
	lastName: string;
	phone: string | null;
	email: string | null;
};

// What Shopify takes: blank stays unset, phones in E.164 (US numbers
// typed without a country code get +1).
export function customerInput(f: CustomerFields) {
	const digits = f.phone?.replace(/\D/g, "") ?? "";
	const phone =
		digits === ""
			? null
			: digits.length === 10 && !f.phone?.trim().startsWith("+")
				? `+1${digits}`
				: `+${digits}`;
	return {
		firstName: f.firstName.trim(),
		lastName: f.lastName.trim(),
		phone,
		email: f.email?.trim() || null,
	};
}

const saved = type({ customer: customerShape.or("null"), userErrors });

function answer(r: typeof saved.infer, doing: string) {
	if (r.userErrors.length > 0 || !r.customer)
		throw new Error(
			`Shopify didn't ${doing}: ${r.userErrors.map((e) => e.message).join("; ") || "nothing came back"}`,
		);
	return toCustomer(r.customer);
}

export async function createCustomer(f: CustomerFields) {
	const data = type({ customerCreate: saved }).assert(
		await shopifyQuery(
			`mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { ${CUSTOMER_FIELDS} } userErrors { field message } } }`,
			{ input: customerInput(f) },
		),
	);
	return answer(data.customerCreate, "add the customer");
}

export async function updateCustomer(id: string, f: CustomerFields) {
	const data = type({ customerUpdate: saved }).assert(
		await shopifyQuery(
			`mutation($input: CustomerInput!) { customerUpdate(input: $input) { customer { ${CUSTOMER_FIELDS} } userErrors { field message } } }`,
			{ input: { id, ...customerInput(f) } },
		),
	);
	return answer(data.customerUpdate, "save the customer");
}
