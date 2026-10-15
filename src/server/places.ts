import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";

// Address lookup through Google's Places API (New), called from the server so
// the key stays private.
//
//   GOOGLE_MAPS_API_KEY  a key with the Places API (New) enabled
//
// A session token ties a run of suggestions to the one place picked from
// them, which Google bills as a single lookup.

const api = "https://places.googleapis.com/v1";

function key() {
	const k = process.env.GOOGLE_MAPS_API_KEY;
	if (!k) throw new Error("Address lookup isn't set up: add GOOGLE_MAPS_API_KEY");
	return k;
}

async function google(path: string, init: RequestInit & { fieldMask?: string }) {
	const res = await fetch(`${api}/${path}`, {
		...init,
		headers: {
			"X-Goog-Api-Key": key(),
			"Content-Type": "application/json",
			...(init.fieldMask ? { "X-Goog-FieldMask": init.fieldMask } : {}),
		},
	});
	const body = await res.json();
	if (!res.ok)
		throw new Error(
			`Google answered ${res.status}: ${body?.error?.message ?? "no details"}`,
		);
	return body;
}

const text = type({ text: "string" });
const suggestions = type({
	"suggestions?": type({
		"placePrediction?": {
			placeId: "string",
			"structuredFormat?": { mainText: text, "secondaryText?": text },
			text,
		},
	}).array(),
});

export type PlaceSuggestion = { placeId: string; main: string; rest: string };

// Businesses as well as street addresses, so typing a supplier's name can
// find where they are.
export const suggestPlaces = createServerFn({ method: "GET" })
	.validator(type({ input: "string", sessionToken: "string" }))
	.handler(async ({ data }): Promise<PlaceSuggestion[]> => {
		const body = suggestions.assert(
			await google("places:autocomplete", {
				method: "POST",
				body: JSON.stringify({
					input: data.input,
					sessionToken: data.sessionToken,
				}),
			}),
		);
		return (body.suggestions ?? []).flatMap(({ placePrediction: p }) =>
			p
				? [
						{
							placeId: p.placeId,
							main: p.structuredFormat?.mainText.text ?? p.text.text,
							rest: p.structuredFormat?.secondaryText?.text ?? "",
						},
					]
				: [],
		);
	});

const place = type({
	"addressComponents?": type({
		longText: "string",
		shortText: "string",
		types: "string[]",
	}).array(),
});

export type PlaceAddress = {
	address1: string;
	address2: string;
	city: string;
	region: string;
	postalCode: string;
	country: string;
};

export const placeAddress = createServerFn({ method: "GET" })
	.validator(type({ placeId: "string", sessionToken: "string" }))
	.handler(async ({ data }): Promise<PlaceAddress> => {
		const body = place.assert(
			await google(
				`places/${encodeURIComponent(data.placeId)}?sessionToken=${encodeURIComponent(data.sessionToken)}`,
				{ method: "GET", fieldMask: "addressComponents" },
			),
		);
		const parts = body.addressComponents ?? [];
		const part = (t: string, short = false) => {
			const c = parts.find((c) => c.types.includes(t));
			return (short ? c?.shortText : c?.longText) ?? "";
		};
		return {
			// Short street names ("Main St"), as they'd be written on a label.
			address1: [part("street_number"), part("route", true)]
				.filter(Boolean)
				.join(" "),
			address2: part("subpremise") && `#${part("subpremise")}`,
			city: part("locality") || part("postal_town") || part("sublocality"),
			region: part("administrative_area_level_1", true),
			postalCode: part("postal_code"),
			country: part("country", true),
		};
	});
