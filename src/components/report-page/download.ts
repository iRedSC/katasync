export function downloadText(filename: string, text: string, type: string) {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([text], { type }));
	a.download = filename;
	a.click();
	URL.revokeObjectURL(a.href);
}
