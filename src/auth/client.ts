import {
	startAuthentication,
	startRegistration,
} from "@simplewebauthn/browser";

// The browser half of signing in and adding a device. Talks to
// src/routes/api/auth/$.ts.

async function post(step: string, body: unknown = {}) {
	const res = await fetch(`/api/auth/${step}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(json.error ?? `Sign-in failed (${res.status})`);
	return json;
}

// The passkey prompt being closed reads as an error; say what happened.
function plain(error: unknown) {
	if (error instanceof Error && error.name === "NotAllowedError")
		return new Error("The passkey prompt was closed or timed out. Try again.");
	return error;
}

export async function signIn() {
	try {
		const optionsJSON = await post("login/options");
		const response = await startAuthentication({ optionsJSON });
		await post("login/verify", { response });
	} catch (error) {
		throw plain(error);
	}
}

export async function addDevice(setupToken: string, name: string) {
	try {
		const optionsJSON = await post("register/options", { setupToken });
		const response = await startRegistration({ optionsJSON });
		await post("register/verify", { setupToken, name, response });
	} catch (error) {
		throw plain(error);
	}
}

export async function signOut() {
	await post("logout");
}

// Where to go after signing in: only a path on this site.
export function safeNext(next: unknown) {
	return typeof next === "string" &&
		next.startsWith("/") &&
		!next.startsWith("//")
		? next
		: "/";
}

// A starting name for this device's passkey, edited before saving.
export function guessDeviceName() {
	const ua = navigator.userAgent;
	if (/iPhone/.test(ua)) return "iPhone";
	if (/iPad/.test(ua)) return "iPad";
	if (/Android/.test(ua)) return "Android phone";
	if (/Mac OS X/.test(ua)) return "Mac";
	if (/Windows/.test(ua)) return "Windows PC";
	return "This device";
}
