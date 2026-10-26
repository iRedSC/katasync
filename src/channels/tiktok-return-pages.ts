export class TiktokReturnPages {
	private readonly ids = new Set<string>();
	private readonly tokens = new Set<string>();
	private total = 0;

	constructor(private readonly name: string) {}

	read(
		rows: { id: string }[],
		page: { next_page_token?: string; total_count?: number },
	) {
		for (const row of rows) {
			if (this.ids.has(row.id))
				throw new Error(`TikTok ${this.name} repeated record ${row.id}`);
			this.ids.add(row.id);
		}
		this.total = Math.max(this.total, page.total_count ?? 0);
		const token = page.next_page_token || undefined;
		if (token) {
			if (this.tokens.has(token))
				throw new Error(`TikTok ${this.name} repeated its page token`);
			this.tokens.add(token);
		} else if (this.ids.size < this.total) {
			throw new Error(
				`TikTok ${this.name} truncated: read ${this.ids.size} of ${this.total}`,
			);
		}
		return token;
	}
}
