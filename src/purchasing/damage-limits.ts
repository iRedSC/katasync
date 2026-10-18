// Limits on damage photos, shared by the server and the pages, so a page can
// say a limit is near before the server refuses.

// What a request may carry on Vercel, and what the table allows.
export const MAX_PHOTO_BYTES = 4_500_000;
export const MAX_PHOTOS = 12;
// Photos one damage report can carry: fewer than Resend's 40 MB per email,
// with room for the text.
export const EMAIL_PHOTO_BYTES = 35_000_000;
