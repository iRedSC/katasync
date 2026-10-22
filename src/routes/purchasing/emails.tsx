import { createFileRoute, redirect } from "@tanstack/react-router";

// Supplier emails moved to the Inbox page; old links and bookmarks land on
// the same view there.
export const Route = createFileRoute("/purchasing/emails")({
	beforeLoad: ({ search }) => {
		const view = (search as { view?: unknown }).view;
		throw redirect({
			to: "/inbox",
			search:
				view === "set-aside" || view === "filed"
					? { box: "purchasing", view }
					: { box: "purchasing" },
			replace: true,
		});
	},
});
