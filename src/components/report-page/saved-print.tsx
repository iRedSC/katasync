import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { getReportArtifact } from "#/server/reports";

export function SavedPrint({
	file,
}: {
	file: Awaited<ReturnType<typeof getReportArtifact>>;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(1100);
	return (
		<div className="min-h-svh bg-surface py-6">
			<div className="mx-auto mb-4 flex max-w-[8.5in] items-center justify-between gap-3">
				<Link
					to="/reports"
					search={{ period: file.period }}
					className="text-muted-foreground hover:text-foreground"
				>
					Back to Reports
				</Link>
				<span className="flex items-center gap-2">
					<span className="font-semibold">Revision {file.revision}</span>
					<code
						className="rounded bg-surface-strong px-1 text-xs"
						title={`sha256 ${file.sha256}`}
					>
						{file.sha256.slice(0, 12)}
					</code>
				</span>
				<button
					type="button"
					onClick={() => frame.current?.contentWindow?.print()}
					className="h-8 rounded-lg bg-primary px-3 font-semibold text-white hover:bg-primary-hover"
				>
					Print
				</button>
			</div>
			<iframe
				ref={frame}
				title={file.filename}
				srcDoc={file.content}
				sandbox="allow-same-origin allow-modals"
				onLoad={(e) =>
					setHeight(
						e.currentTarget.contentDocument?.documentElement.scrollHeight ??
							height,
					)
				}
				style={{ height }}
				className="mx-auto block w-full max-w-[8.5in] bg-white shadow-card"
			/>
		</div>
	);
}
