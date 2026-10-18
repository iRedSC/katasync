import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Tip } from "#/components/ui/tooltip";
import type { Hint } from "#/diagnostics/health";

export function copy(text: string) {
	navigator.clipboard.writeText(text).then(() => toast.success("Copied"));
}

export function Facts({ children }: { children: ReactNode }) {
	return (
		<dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-1">{children}</dl>
	);
}

export function Fact({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd>{children}</dd>
		</>
	);
}

export function ErrorBlock({ title, text }: { title: string; text: string }) {
	return (
		<div className="rounded-lg border border-critical-border bg-critical-surface p-3">
			<div className="mb-1 flex items-center justify-between font-medium text-critical-text">
				{title}
				<Tip content="Copy">
					<button type="button" aria-label="Copy" onClick={() => copy(text)}>
						<Copy className="size-3.5" />
					</button>
				</Tip>
			</div>
			<pre className="max-h-48 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
				{text}
			</pre>
		</div>
	);
}

export function HintBlock({ hint }: { hint: Hint }) {
	return (
		<div className="rounded-lg border border-info-border bg-info-surface p-3">
			<p className="font-medium">{hint.title}</p>
			<p className="text-muted-foreground">{hint.action}</p>
		</div>
	);
}
