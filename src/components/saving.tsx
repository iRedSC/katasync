import { useSaving } from "#/lib/optimism";
import { cn } from "#/lib/utils";

// Changes show before the server has them; this says it's still catching up.
// It waits a moment before showing, so a change that lands at once doesn't
// flash it, and says nothing when there's nothing to say.
export function Saving({ className }: { className?: string }) {
	const saving = useSaving();
	return (
		<span
			aria-live="polite"
			className={cn(
				"transition-opacity",
				saving ? "opacity-100 delay-300" : "opacity-0",
				className,
			)}
		>
			{saving && "Saving…"}
		</span>
	);
}
