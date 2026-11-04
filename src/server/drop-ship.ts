import { createServerFn } from "@tanstack/react-start";
import { type } from "arktype";
import { getDb } from "#/db/client";
import { DROP_SHIP_CARRIERS } from "#/orders/drop-ship";
import {
	markDropShip,
	sendDropShipTracking,
	unmarkDropShip,
} from "#/shipping/drop-ship";

const order = type({ orderId: "number.integer > 0" });

export const markOrderDropShip = createServerFn({ method: "POST" })
	.validator(order)
	.handler(({ data }) => markDropShip(getDb(), data.orderId));

export const unmarkOrderDropShip = createServerFn({ method: "POST" })
	.validator(order)
	.handler(({ data }) => unmarkDropShip(getDb(), data.orderId));

// tracking null: the supplier never sent any.
export const sendOrderDropShipTracking = createServerFn({ method: "POST" })
	.validator(
		type({
			orderId: "number.integer > 0",
			tracking: type({
				carrier: type.enumerated(...DROP_SHIP_CARRIERS),
				number: "0 < string <= 60",
			}).or("null"),
		}),
	)
	.handler(({ data }) =>
		sendDropShipTracking(getDb(), data.orderId, data.tracking),
	);
