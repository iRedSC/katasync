import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import {
	markPickedUp,
	markReadyForPickup,
	undoPickedUp,
} from "#/shipping/pickup";

const order = type({ orderId: "number.integer > 0" });

export const readyOrderForPickup = createServerFn({ method: "POST" })
	.validator(order)
	.handler(({ data }) => markReadyForPickup(getDb(), data.orderId));

export const pickUpOrder = createServerFn({ method: "POST" })
	.validator(order)
	.handler(({ data }) => markPickedUp(getDb(), data.orderId));

export const undoOrderPickedUp = createServerFn({ method: "POST" })
	.validator(
		type({
			orderId: "number.integer > 0",
			fulfillmentId: /^gid:\/\/shopify\/Fulfillment\/\d+$/,
		}),
	)
	.handler(({ data }) =>
		undoPickedUp(getDb(), data.orderId, data.fulfillmentId),
	);
