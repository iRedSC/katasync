import { createFileRoute, redirect } from "@tanstack/react-router";
import { purchasingFolderOf } from "#/components/inbox/folders";

// Supplier emails moved to the Inbox page; old links and bookmarks land on
// the same view there.
export const Route = createFileRoute("/purchasing/emails")({
	beforeLoad: ({ search }) => {
		const view = (search as { view?: unknown }).view;
		throw redirect({
			to: "/inbox",
			search: { folder: purchasingFolderOf(view) ?? "unfiled" },
			replace: true,
		});
	},
});
