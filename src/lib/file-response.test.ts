import { expect, test } from "vitest";
import { fileResponse } from "./file-response";

const recording = {
	filename: "voicemail.mp3",
	contentType: "application/octet-stream",
	data: Buffer.from("0123456789"),
};

test("MP3 recordings are playable inline, including generic attachment MIME types", async () => {
	const response = fileResponse(recording);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("audio/mpeg");
	expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
	expect(response.headers.get("cache-control")).toContain("private");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	expect(await response.text()).toBe("0123456789");
});

test.each([
	["bytes=2-5", "2345", "bytes 2-5/10"],
	["bytes=5-", "56789", "bytes 5-9/10"],
	["bytes=-3", "789", "bytes 7-9/10"],
	["bytes=5-100", "56789", "bytes 5-9/10"],
])("supports seeking with %s", async (range, expected, contentRange) => {
	const response = fileResponse(recording, range);
	expect(response.status).toBe(206);
	expect(response.headers.get("content-range")).toBe(contentRange);
	expect(response.headers.get("content-length")).toBe(String(expected.length));
	expect(await response.text()).toBe(expected);
});

test.each([
	"bytes=10-",
	"bytes=5-2",
	"bytes=-0",
	"bytes=-",
	"bytes=0-1,3-4",
	"invalid",
	"bytes=999999999999999999-",
])("rejects an unsatisfiable range: %s", (range) => {
	const response = fileResponse(recording, range);
	expect(response.status).toBe(416);
	expect(response.headers.get("content-range")).toBe("bytes */10");
});

test("untrusted HTML remains a download", () => {
	const response = fileResponse({
		filename: "mail.html",
		contentType: "text/html",
		data: Buffer.from("<script>bad()</script>"),
	});
	expect(response.headers.get("content-type")).toBe("application/octet-stream");
	expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
});
