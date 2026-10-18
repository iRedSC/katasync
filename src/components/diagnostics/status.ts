import type { Tone } from "#/components/page";
import type { Health } from "#/diagnostics/health";
import type { Diagnostics } from "#/server/diagnostics";

export type ChannelData = Diagnostics["channels"][number];

export const HEALTH: Record<Health, { label: string; tone?: Tone }> = {
	healthy: { label: "Healthy", tone: "success" },
	degraded: { label: "Some orders failing", tone: "warning" },
	failing: { label: "Sync failing", tone: "critical" },
	stale: { label: "No recent sync", tone: "warning" },
	never_synced: { label: "Never synced" },
	not_connected: { label: "Not connected" },
};

export function ago(at: Date | string | null) {
	if (!at) return "never";
	const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

export function channelDetail(c: ChannelData) {
	switch (c.health) {
		case "healthy":
		case "degraded":
			return `Synced ${ago(c.lastSuccessAt)}`;
		case "failing":
			return `Failing since ${ago(c.failingSince)}`;
		case "stale":
			return `Last sync ${ago(c.lastSuccessAt)}`;
		default:
			return HEALTH[c.health].label;
	}
}

export function shippoStatus(s: Diagnostics["services"]["shippo"]) {
	if (!s.configured) return { label: "Not set up", tone: "warning" as const };
	if (s.test) return { label: "Test key", tone: "warning" as const };
	return { label: "Live", tone: "success" as const };
}

export function emailStatus(s: Diagnostics["services"]["email"]) {
	return s.configured
		? { label: "Set up", tone: "success" as const }
		: { label: "Not set up", tone: "warning" as const };
}
