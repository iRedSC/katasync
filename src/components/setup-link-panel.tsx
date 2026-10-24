import QRCode from "qrcode";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";

export type MadeLink = {
	forName: string;
	url: string;
	qr: string;
	expiresAt: Date;
};

export async function madeLink(
	forName: string,
	made: { url: string; expiresAt: Date | string },
): Promise<MadeLink> {
	return {
		forName,
		url: made.url,
		expiresAt: new Date(made.expiresAt),
		qr: await QRCode.toDataURL(made.url, { margin: 1, width: 192 }),
	};
}

export function SetupLinkPanel({
	link,
	onDone,
}: {
	link: MadeLink;
	onDone: () => void;
}) {
	return (
		<div className="flex gap-4 border-t bg-info-fill/40 px-4 py-3 animate-in fade-in slide-in-from-top-1">
			<img src={link.qr} alt="Setup link" className="size-36 shrink-0" />
			<div className="flex min-w-0 flex-col gap-2">
				<p>
					For <span className="font-medium">{link.forName}</span>. Works once,
					until{" "}
					{link.expiresAt.toLocaleTimeString([], {
						hour: "numeric",
						minute: "2-digit",
					})}
					.
				</p>
				<code className="truncate rounded bg-surface px-2 py-1 text-xs">
					{link.url}
				</code>
				<div className="flex gap-2">
					<Button
						size="sm"
						variant="outline"
						onClick={() =>
							navigator.clipboard
								.writeText(link.url)
								.then(() => toast.success("Copied"))
						}
					>
						Copy link
					</Button>
					<Button size="sm" variant="ghost" onClick={onDone}>
						Done
					</Button>
				</div>
			</div>
		</div>
	);
}
