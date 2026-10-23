export type OrderUpdate =
	| { kind: "applied" }
	| { kind: "ignored"; reason: "tiktok_source" }
	| { kind: "retry"; error: string };

export type WebhookUpdate = OrderUpdate | { kind: "busy" };

export function orderUpdate(problems: string[]): OrderUpdate {
	return problems.length > 0
		? { kind: "retry", error: problems.join("; ") }
		: { kind: "applied" };
}
