export function requestOperation(request: Request): string {
	const path = new URL(request.url).pathname;
	const route = path.startsWith("/api/uploads/po-file/")
		? "/api/uploads/po-file/$token"
		: "/request";
	return `${request.method} ${route}`;
}
