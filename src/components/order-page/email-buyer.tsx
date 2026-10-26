import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle, Mail } from "lucide-react";
import { useRef, useState } from "react";
import { shake } from "#/components/shake";
import { Button } from "#/components/ui/button";
import { Tip } from "#/components/ui/tooltip";
import type { OrderDetail } from "#/server/orders";
import { emailShopifyBuyer } from "#/server/shopify-email";

// A Shopify buyer's email, and the button that opens their conversation in
// the Buyers inbox (started the first time), where it's written and sent.
export function EmailBuyer({
	orderId,
	email,
	started,
}: {
	orderId: number;
	email: NonNullable<OrderDetail["emailBuyer"]>;
	// A conversation with them about this order already exists.
	started: boolean;
}) {
	const navigate = useNavigate();
	const button = useRef<HTMLButtonElement>(null);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function open() {
		setOpening(true);
		setError(null);
		try {
			const { threadId } = await emailShopifyBuyer({ data: { orderId } });
			await navigate({
				to: "/inbox",
				search: { folder: "buyers", thread: threadId },
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			shake(button.current);
		} finally {
			setOpening(false);
		}
	}

	const action = (
		<Button
			ref={button}
			type="button"
			size="sm"
			variant="outline"
			disabled={opening || email.unready !== null}
			onClick={open}
		>
			{opening ? <LoaderCircle className="animate-spin" /> : <Mail />}
			{started ? "Open conversation" : "Email buyer"}
		</Button>
	);
	return (
		<div className="mt-2 flex flex-col items-start gap-1.5">
			<p className="max-w-full truncate text-muted-foreground select-all">
				{email.to}
			</p>
			{email.unready ? (
				<Tip content={email.unready}>
					<span>{action}</span>
				</Tip>
			) : (
				action
			)}
			{error && <p className="text-xs text-critical-text">{error}</p>}
		</div>
	);
}
