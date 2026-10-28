import { afterEach, expect, test, vi } from "vitest";
import {
	downloadPicture,
	MAX_PICTURE_BYTES,
	mediaHost,
	sourceKey,
} from "./tiktok-return-records";

afterEach(() => vi.unstubAllGlobals());

const PHOTO =
	"https://p16-oec-general-useast5.ttcdn-us.com/tos/a~tplv.jpeg?shp=1";

// Answers each fetch in turn, recording what was asked.
function serve(...responses: (() => Response)[]) {
	const asked: { url: string; redirect?: RequestRedirect }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			asked.push({ url, redirect: init?.redirect });
			const next = responses.shift();
			if (!next) throw new Error("no more answers");
			return next();
		}),
	);
	return asked;
}

const image = (body: BodyInit = "jpeg", headers: Record<string, string> = {}) =>
	new Response(body, { headers: { "content-type": "image/jpeg", ...headers } });
const moved = (to: string) =>
	new Response(null, { status: 302, headers: { location: to } });

test("a picture's key survives a new host and signature", () => {
	expect(sourceKey(PHOTO)).toBe(
		sourceKey(
			"https://p19-oec-general-useast5.ttcdn-us.com/tos/a~tplv.jpeg?shp=2",
		),
	);
});

test.each([
	[PHOTO, true],
	["https://p16-oec-va.ibyteimg.com/obj/x.jpeg", true],
	["http://p16-oec-general-useast5.ttcdn-us.com/tos/a.jpeg", false],
	["https://ttcdn-us.com.evil.example/a.jpeg", false],
	["https://evilttcdn-us.com/a.jpeg", false],
	["https://169.254.169.254/latest/meta-data", false],
	["https://user:pw@p16.ttcdn-us.com/a.jpeg", false],
	["https://p16.ttcdn-us.com:8443/a.jpeg", false],
	["not a url", false],
])("only TikTok's media hosts, over https: %s", (url, allowed) => {
	expect(mediaHost(url)).toBe(allowed);
});

test("a photo TikTok serves is kept, without following redirects itself", async () => {
	const asked = serve(() => image());
	expect(await downloadPicture(PHOTO)).toEqual({
		kind: "kept",
		contentType: "image/jpeg",
		data: Buffer.from("jpeg"),
	});
	expect(asked).toEqual([{ url: PHOTO, redirect: "manual" }]);
});

test("a host that isn't TikTok's is refused before anything is fetched", async () => {
	const asked = serve();
	expect(await downloadPicture("https://169.254.169.254/x")).toEqual({
		kind: "refused",
	});
	expect(asked).toEqual([]);
});

test("each redirect is checked: TikTok to TikTok is followed, elsewhere refused", async () => {
	const other = "https://p19-oec-general-useast5.ttcdn-us.com/tos/b.jpeg";
	expect(
		serve(
			() => moved(other),
			() => image(),
		).length,
	).toBe(0);
	expect(await downloadPicture(PHOTO)).toMatchObject({ kind: "kept" });

	const asked = serve(() => moved("http://10.0.0.1/admin"));
	expect(await downloadPicture(PHOTO)).toEqual({ kind: "refused" });
	expect(asked).toHaveLength(1);
});

test("more than three redirects fail", async () => {
	serve(
		() => moved(PHOTO),
		() => moved(PHOTO),
		() => moved(PHOTO),
		() => moved(PHOTO),
	);
	expect(await downloadPicture(PHOTO)).toEqual({ kind: "failed" });
});

test.each([404, 410])("%i is missing", async (status) => {
	serve(() => new Response("", { status }));
	expect(await downloadPicture(PHOTO)).toEqual({ kind: "missing" });
});

test("a 403 might pass on a fresh link, so it only failed", async () => {
	serve(() => new Response("", { status: 403 }));
	expect(await downloadPicture(PHOTO)).toEqual({ kind: "failed" });
});

test("too big by its length is refused unread", async () => {
	let pulled = false;
	// Pulled only when read.
	const body = new ReadableStream(
		{
			pull() {
				pulled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	serve(() => image(body, { "content-length": String(MAX_PICTURE_BYTES + 1) }));
	expect(await downloadPicture(PHOTO)).toEqual({ kind: "failed" });
	expect(pulled).toBe(false);
});

test("too big while streaming stops reading once past the cap", async () => {
	const chunk = new Uint8Array(1_000_000);
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			sent++;
			controller.enqueue(chunk);
		},
	});
	serve(() => image(body));
	expect(await downloadPicture(PHOTO)).toEqual({ kind: "failed" });
	expect(sent).toBeLessThanOrEqual(MAX_PICTURE_BYTES / chunk.length + 2);
});

test("something not a picture, a server error, or a reset failed", async () => {
	serve(
		() => new Response("<html>", { headers: { "content-type": "text/html" } }),
	);
	expect(await downloadPicture(PHOTO)).toEqual({ kind: "failed" });
	serve(() => new Response("", { status: 503 }));
	expect(await downloadPicture(PHOTO)).toEqual({ kind: "failed" });
	serve(() => {
		throw new Error("reset");
	});
	expect(await downloadPicture(PHOTO)).toEqual({ kind: "failed" });
});
