import { Tile, TileGrid } from "#/components/panel";
import type { CheckTarget } from "#/diagnostics/checks";
import { channelName } from "#/lib/format";
import type { Diagnostics } from "#/server/diagnostics";
import {
	channelDetail,
	emailStatus,
	HEALTH,
	inboxStatus,
	shippoStatus,
} from "./status";

export function Connections({
	d,
	open,
}: {
	d: Diagnostics;
	open: (target: CheckTarget) => void;
}) {
	const shippo = shippoStatus(d.services.shippo);
	const email = emailStatus(d.services.email);
	const inbox = inboxStatus(d.services.inbox);
	return (
		<TileGrid>
			{d.channels.map((c) => (
				<Tile
					key={c.channel}
					name={channelName(c.channel)}
					status={HEALTH[c.health].tone ?? "neutral"}
					detail={channelDetail(c)}
					onClick={() => open(c.channel)}
				/>
			))}
			<Tile
				name="Shippo"
				status={shippo.tone}
				detail={shippo.label}
				onClick={() => open("shippo")}
			/>
			<Tile
				name="PO email"
				status={email.tone}
				detail={email.label}
				onClick={() => open("email")}
			/>
			<Tile
				name="PO inbox"
				status={inbox.tone}
				detail={inbox.label}
				onClick={() => open("inbox")}
			/>
		</TileGrid>
	);
}
