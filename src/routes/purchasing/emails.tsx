import { createFileRoute, redirect } from "@tanstack/react-router";

// Supplier emails moved to the Inbox page; old links and bookmarks land on
// the same view there.
export const Route = createFileRoute("/purchasing/emails")({
	beforeLoad: ({ search }) => {
		const view = (search as { view?: unknown }).view;
		throw redirect({
			to: "/inbox",
			search: {
				folder:
					view === "set-aside"
						? "set-aside"
						: view === "filed"
							? "on-po"
							: "to-file",
			},
			replace: true,
		});
	},
});
