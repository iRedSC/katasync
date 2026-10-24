import { expect, test } from "vitest";
import { returnCarrier, trackingFor } from "./return-tracking";

test("a marketplace's name for the carrier, or the number's shape", () => {
	expect(returnCarrier("UPS Ground", "1Z999AA10123456784")).toBe("ups");
	expect(returnCarrier("USPS", "930201062339000000000")).toBe("usps");
	expect(returnCarrier("FedEx Home", "123456789012")).toBe("fedex");
	expect(returnCarrier(null, "9302010623390000000000")).toBe("usps");
	expect(returnCarrier("DHL", "ABC")).toBeNull();
});

test("what's saved counts only for the number the request has now", () => {
	const saved = { number: "1Z999AA10123456784" };
	expect(trackingFor("1z999aa1 0123456784", saved)).toBe(saved);
	expect(trackingFor("1Z999AA10123456785", saved)).toBeNull();
	expect(trackingFor(null, saved)).toBeNull();
});
