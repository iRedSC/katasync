import { toast } from "sonner";

// Copies text and says so, or says why it couldn't (e.g. the page isn't
// focused, or the browser blocks clipboard access).
export async function copyText(text: string, what = text) {
	try {
		await navigator.clipboard.writeText(text);
		toast(`Copied ${what}`);
	} catch {
		toast.error(`Couldn't copy ${what}`);
	}
}
