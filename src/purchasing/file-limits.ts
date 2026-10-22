// How big a file a PO takes, shared by the server and the page, so the page
// can refuse one before uploading it. Under what a request may carry on
// Vercel (4.5 MB), with room for the form around it; the table allows 4.5.
export const MAX_PO_FILE_BYTES = 4_400_000;
