// US states by postal code, and how to name a place an order went to.
export const US_STATES: Record<string, string> = {
	AL: "Alabama",
	AK: "Alaska",
	AZ: "Arizona",
	AR: "Arkansas",
	CA: "California",
	CO: "Colorado",
	CT: "Connecticut",
	DE: "Delaware",
	DC: "District of Columbia",
	FL: "Florida",
	GA: "Georgia",
	HI: "Hawaii",
	ID: "Idaho",
	IL: "Illinois",
	IN: "Indiana",
	IA: "Iowa",
	KS: "Kansas",
	KY: "Kentucky",
	LA: "Louisiana",
	ME: "Maine",
	MD: "Maryland",
	MA: "Massachusetts",
	MI: "Michigan",
	MN: "Minnesota",
	MS: "Mississippi",
	MO: "Missouri",
	MT: "Montana",
	NE: "Nebraska",
	NV: "Nevada",
	NH: "New Hampshire",
	NJ: "New Jersey",
	NM: "New Mexico",
	NY: "New York",
	NC: "North Carolina",
	ND: "North Dakota",
	OH: "Ohio",
	OK: "Oklahoma",
	OR: "Oregon",
	PA: "Pennsylvania",
	RI: "Rhode Island",
	SC: "South Carolina",
	SD: "South Dakota",
	TN: "Tennessee",
	TX: "Texas",
	UT: "Utah",
	VT: "Vermont",
	VA: "Virginia",
	WA: "Washington",
	WV: "West Virginia",
	WI: "Wisconsin",
	WY: "Wyoming",
	PR: "Puerto Rico",
};

const countries = new Intl.DisplayNames(["en"], { type: "region" });

// A US state by name, or a country by name when the order left the US.
export function placeName(place: { country: string; state: string | null }) {
	if (place.country !== "US")
		return countries.of(place.country) ?? place.country;
	if (place.state === null) return "Unknown state";
	return US_STATES[place.state] ?? place.state;
}

// A tax's name, with its country when it isn't American ("Ireland: Tax").
export function taxName(t: { country: string; jurisdiction: string }) {
	return t.country === "US"
		? t.jurisdiction
		: `${placeName({ country: t.country, state: null })}: ${t.jurisdiction}`;
}
