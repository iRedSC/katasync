import { describe, expect, test } from "vitest";
import {
	isMp3,
	isVoicemail,
	voicemailContent,
	voicemailDecision,
	voicemailState,
} from "./voicemail-model";

describe("Ooma source detection", () => {
	test("requires the exact sender and voicemail subject", () => {
		expect(
			isVoicemail({
				fromAddress: "NO_REPLY@OOMA.COM",
				subject: "New voicemail from East Coast (00:00:04)",
			}),
		).toBe(true);
		expect(
			isVoicemail({
				fromAddress: "no_reply@ooma.com.attacker.test",
				subject: "New voicemail",
			}),
		).toBe(false);
		expect(
			isVoicemail({
				fromAddress: "no_reply@ooma.com",
				subject: "Your account",
			}),
		).toBe(false);
	});
	test("recognizes an explicitly forwarded Ooma header, not a mention of Ooma", () => {
		expect(
			isVoicemail({
				fromAddress: "staff@example.com",
				subject: "Fwd: New voicemail",
				body: "From: Ooma <no_reply@ooma.com>\nSent: Sunday",
			}),
		).toBe(true);
		expect(
			isVoicemail({
				fromAddress: "staff@example.com",
				subject: "FW: New voicemail",
				body: "From: no_reply@ooma.com\nSent: Sunday",
			}),
		).toBe(true);
		expect(
			isVoicemail({
				fromAddress: "staff@example.com",
				subject: "FW: New voicemail",
				body: "Contact no_reply@ooma.com",
			}),
		).toBe(false);
	});
});

test("extracts the screenshot's fields without including Ooma's footer", () => {
	expect(
		voicemailContent(
			"Account: East Coast Dry Wall\r\nNew Voicemail Received\r\nCaller Name\tEast Coast COMO EN CAS\r\nCaller Number\t(956) 515-5660\r\nDuration\t00:00:04\r\nVoicemail Preview:\r\nYou\r\n\r\nTo listen to this voicemail, click on the attachment in this email.",
		),
	).toEqual({
		callerName: "East Coast COMO EN CAS",
		callerNumber: "(956) 515-5660",
		duration: "00:00:04",
		transcript: "You",
	});
});

test("handles table cells rendered on separate lines and preserves the original transcript", () => {
	expect(
		voicemailContent(
			"Caller Name\nJane Doe\nCaller Number\n(800) 555-1234\nDuration\n00:01:30\nVoicemail Preview:\nMy order is missing.\nPlease call me.\nTo listen to this voicemail, click the attachment.",
		),
	).toEqual({
		callerName: "Jane Doe",
		callerNumber: "(800) 555-1234",
		duration: "00:01:30",
		transcript: "My order is missing.\nPlease call me.",
	});
	expect(voicemailContent("No preview").transcript).toBe("");
});

test("recognizes MP3s even with a generic MIME type", () => {
	expect(
		isMp3({
			filename: "recording.MP3",
			contentType: "application/octet-stream",
		}),
	).toBe(true);
	expect(isMp3({ filename: "recording", contentType: "audio/mpeg" })).toBe(
		true,
	);
	expect(
		isMp3({
			filename: "recording.exe",
			contentType: "application/octet-stream",
		}),
	).toBe(false);
});

test("missing caller metadata cannot borrow the next field's label", () => {
	expect(
		voicemailContent(
			"Caller Name\nCaller Number\n(800) 555-1234\nDuration\n00:00:04\nVoicemail Preview:\nYou",
		),
	).toEqual({
		callerName: null,
		callerNumber: "(800) 555-1234",
		duration: "00:00:04",
		transcript: "You",
	});
});

test("rejects incomplete results and mixed processing states", () => {
	expect(
		voicemailDecision.safeParse({ state: "ready", title: "Call customer" })
			.success,
	).toBe(false);
	expect(
		voicemailDecision.safeParse({ state: "dismissed", reason: "" }).success,
	).toBe(false);
	expect(voicemailState.safeParse({ state: "processing" }).success).toBe(false);
});
