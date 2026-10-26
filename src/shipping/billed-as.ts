// Kept apart from quick-ship.ts so the browser can read re-bill lines
// without loading the database.

// What a carrier says it measured, when its re-bill line says (UPS's
// "Shipping Charge Correction" does): the size in inches and weight in
// pounds it billed for.
export function billedAs(
	description: string,
): { inches: number[]; pounds: number | null } | null {
	const dims =
		/Billed Dimensions \(in\):\s*([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/i.exec(
			description,
		);
	if (!dims) return null;
	const weight = /Billed Weight \(lb\):\s*([\d.]+)/i.exec(description);
	return {
		inches: dims.slice(1, 4).map(Number),
		pounds: weight ? Number(weight[1]) : null,
	};
}
