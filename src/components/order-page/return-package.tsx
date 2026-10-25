import { useMemo, useRef, useState } from "react";
import {
	flashFailed,
	PackageHead,
	usePackageRead,
} from "#/components/package-read";
import { CARRIER, PackageStatus } from "#/components/package-status";
import {
	knownOf,
	TERMINAL,
	type Tracked,
	type TrackingRead,
} from "#/orders/tracking-read";
import { followReturnNow, setReturnFollowed } from "#/server/orders";

// The package a return request names, followed on Shippo as a PO's are:
// asked again as its order opens, then every four hours until it gets
// there or goes back, the request closes, or staff stop following it. A
// failed ask keeps the last scans, marked stale.

export function ReturnPackage({
	id,
	carrier,
	number,
	page,
	saved,
	open,
	unfollowed: wasUnfollowed,
}: {
	id: number;
	carrier: string | null;
	number: string;
	// The carrier's own tracking page; null when the carrier isn't known.
	page: string | null;
	// What Shippo last said, kept; null until it's answered.
	saved: Tracked | null;
	// The request is still open on the marketplace.
	open: boolean;
	unfollowed: boolean;
}) {
	const [unfollowed, setUnfollowed] = useState(wasUnfollowed);
	const initial = useMemo<TrackingRead | null>(
		() => (saved ? { state: "fresh", t: saved } : null),
		[saved],
	);
	// Asked as it shows only while there's more to learn.
	const askNow =
		!unfollowed &&
		(saved === null || (open && !TERMINAL.includes(saved.status)));
	const { read, asking, retry, row } = usePackageRead(
		initial,
		() => followReturnNow({ data: { id } }),
		askNow,
	);
	const toggle = useRef<HTMLButtonElement>(null);
	// Undone by the same button; following again asks at once, as askNow
	// turns on.
	const follow = (followed: boolean) => {
		setUnfollowed(!followed);
		setReturnFollowed({ data: { id, followed } }).catch(() => {
			setUnfollowed(followed);
			flashFailed(toggle.current);
		});
	};
	const t = knownOf(read);
	const name = t
		? (CARRIER[t.carrier as keyof typeof CARRIER] ?? t.carrier)
		: (carrier ?? "");
	return (
		<div ref={row} className="-mx-2 mt-2 rounded-lg px-2">
			<PackageHead
				label={`${name} ${t?.number ?? number}`.trim()}
				page={page}
				read={read}
				asking={asking}
				retry={unfollowed ? null : retry}
			/>
			{t ? (
				<PackageStatus t={t} />
			) : (
				asking && (
					<PackageStatus
						t={{
							carrier: carrier ?? "",
							number,
							status: null,
							statusDetail: null,
							statusAt: null,
							eta: null,
							originalEta: null,
							service: null,
							origin: null,
							destination: null,
							history: [],
							checkedAt: null,
						}}
					/>
				)
			)}
			{open && !(t && TERMINAL.includes(t.status)) && (
				<button
					ref={toggle}
					type="button"
					onClick={() => follow(unfollowed)}
					className="mt-1 rounded-md text-xs text-muted-foreground hover:text-foreground"
				>
					{unfollowed ? "Not followed · Follow again" : "Stop following"}
				</button>
			)}
		</div>
	);
}
