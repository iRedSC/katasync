import { ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";

// Orders whose label comes from the marketplace: Enter opens its page.
export function ExternalStep({
	name,
	onOpen,
}: {
	name: string;
	onOpen: () => void;
}) {
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => button.current?.focus(), []);
	return (
		<div className="flex flex-col items-center gap-4 py-4 text-center">
			<p className="text-2xl font-semibold">Ships on {name}'s own label</p>
			<button
				ref={button}
				type="button"
				onClick={onOpen}
				className="inline-flex h-16 items-center gap-3 rounded-xl bg-primary px-8 text-xl font-semibold text-white outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
			>
				Open fulfillment page
				<ExternalLink className="size-6" />
			</button>
		</div>
	);
}
