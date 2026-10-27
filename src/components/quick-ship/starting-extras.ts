import type { ShipmentPlan } from "#/shipping/quick-ship";
import type { Extras } from "./types";

export const noExtras: Extras = { insure: null, signature: false };

// Each plan starts uninsured (insurance is only recommended), with a
// signature only when one is required. Going back to fix a box or weight
// keeps whatever was changed on the service step.
export const startingExtras = (plan: ShipmentPlan): Extras => ({
	insure: null,
	signature: plan.signatureRequired !== null,
});

export const sameExtras = (a: Extras, b: Extras) =>
	a.insure === b.insure && a.signature === b.signature;
