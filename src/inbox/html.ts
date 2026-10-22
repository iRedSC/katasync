// An email's HTML as katasync keeps it: each picture inside it (cid:) points
// at the attachment kept for it, so the formatted email shows them without
// reaching Microsoft 365 again.

export function pointPictures(
	html: string,
	pictures: { contentId: string; url: string }[],
) {
	let out = html;
	for (const p of pictures) out = out.split(`cid:${p.contentId}`).join(p.url);
	return out;
}
