import {
	type AuthenticationResponseJSON,
	type AuthenticatorTransport,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	type RegistrationResponseJSON,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { passkeyStaff } from "#/db/identity-schema";
import { passkeys } from "#/db/schema";
import { checkSetupLink, spendSetupLink } from "./enrollment";
import { standingOfPasskey } from "./principal";
import {
	AuthError,
	consumeChallenge,
	createSession,
	hashToken,
	saveChallenge,
} from "./sessions";

// Creating a passkey on a new device, and signing in with one. Server only.

// Passkeys belong to one domain: the address katasync is opened at. Ones made
// on another address (the Tailscale dev server, say) don't work here.
export function relyingParty() {
	const setting = process.env.AUTH_ORIGIN?.trim();
	const example = "e.g. https://katasync.example.com";
	if (!setting)
		throw new AuthError(
			`Set AUTH_ORIGIN to the address katasync is opened at, ${example}`,
		);
	// The browser reports a bare origin, so a trailing slash or path in the
	// setting would fail every check. Keep only the origin.
	let url: URL;
	try {
		url = new URL(setting);
	} catch {
		throw new AuthError(
			`AUTH_ORIGIN needs to be a full address with https://, ${example}`,
		);
	}
	return { origin: url.origin, id: url.hostname, name: "katasync" };
}

// Each person's passkeys share a user handle, so a shared computer can hold
// one passkey per person without one replacing another.
const userHandle = (staffId: string) =>
	new TextEncoder().encode(`katasync-staff:${staffId}`);

export function passkeyName(raw: string) {
	const name = raw.trim().replace(/\s+/g, " ");
	if (name === "") throw new AuthError("Name this device");
	if (name.length > 40) throw new AuthError("Keep the name under 40");
	return name;
}

export async function registrationOptions(db: Db, setupToken: string) {
	const link = await checkSetupLink(db, setupToken);
	const rp = relyingParty();
	const existing = await db
		.select({ id: passkeys.id, transports: passkeys.transports })
		.from(passkeys)
		.innerJoin(passkeyStaff, eq(passkeyStaff.passkeyId, passkeys.id))
		.where(eq(passkeyStaff.staffId, link.staffId));
	const options = await generateRegistrationOptions({
		rpName: rp.name,
		rpID: rp.id,
		userID: userHandle(link.staffId),
		userName: link.staffName,
		userDisplayName: link.staffName,
		attestationType: "none",
		excludeCredentials: existing.map((p) => ({
			id: p.id,
			transports: p.transports as AuthenticatorTransport[],
		})),
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "preferred",
		},
	});
	await saveChallenge(db, options.challenge, {
		purpose: "register",
		setupTokenHash: link.tokenHash,
	});
	return options;
}

// Who a setup link adds a device for, for the page it opens.
export async function setupLinkFor(db: Db, setupToken: string) {
	const { staffName } = await checkSetupLink(db, setupToken);
	return { staffName };
}

// Saves the new device's passkey for the person the link was made for, uses
// up the link, and signs the device in. Returns the session token for its
// cookie.
export async function finishRegistration(
	db: Db,
	input: {
		setupToken: string;
		name: string;
		response: RegistrationResponseJSON;
	},
) {
	const name = passkeyName(input.name);
	const rp = relyingParty();
	const setupTokenHash = hashToken(input.setupToken);
	const result = await verifyRegistrationResponse({
		response: input.response,
		expectedChallenge: (challenge) =>
			consumeChallenge(db, challenge, { purpose: "register", setupTokenHash }),
		expectedOrigin: rp.origin,
		expectedRPID: rp.id,
		requireUserVerification: false,
	});
	if (!result.verified)
		throw new AuthError("The passkey couldn't be verified; try again");
	const { credential } = result.registrationInfo;
	return db.transaction(async (tx) => {
		const { staffId } = await spendSetupLink(tx, input.setupToken);
		await tx.insert(passkeys).values({
			id: credential.id,
			publicKey: Buffer.from(credential.publicKey).toString("base64url"),
			counter: credential.counter,
			transports: credential.transports ?? [],
			name,
		});
		await tx.insert(passkeyStaff).values({ passkeyId: credential.id, staffId });
		return createSession(tx, credential.id);
	});
}

// Any of the account's passkeys may answer, so none are listed.
export async function authenticationOptions(db: Db) {
	const options = await generateAuthenticationOptions({
		rpID: relyingParty().id,
		userVerification: "preferred",
	});
	await saveChallenge(db, options.challenge, { purpose: "login" });
	return options;
}

// Checks a sign-in and returns the session token for its cookie.
export async function finishAuthentication(
	db: Db,
	response: AuthenticationResponseJSON,
) {
	const [passkey] = await db
		.select()
		.from(passkeys)
		.where(eq(passkeys.id, response.id));
	if (!passkey)
		throw new AuthError(
			"This passkey was removed. Ask an owner for a setup link.",
		);
	if ((await standingOfPasskey(db, passkey.id)).kind !== "active")
		throw new AuthError("This person was removed. Ask an owner.");
	const rp = relyingParty();
	const result = await verifyAuthenticationResponse({
		response,
		expectedChallenge: (challenge) =>
			consumeChallenge(db, challenge, { purpose: "login" }),
		expectedOrigin: rp.origin,
		expectedRPID: rp.id,
		credential: {
			id: passkey.id,
			publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
			counter: passkey.counter,
			transports: passkey.transports as AuthenticatorTransport[],
		},
		requireUserVerification: false,
	});
	if (!result.verified) throw new AuthError("Sign-in couldn't be verified");
	// Only move the counter on from the value we verified against. If another
	// sign-in got there first, this one is refused rather than rolling the
	// counter back, which would hide a cloned passkey. Passkeys that always
	// report 0 write 0 over 0 and match every time.
	const updated = await db
		.update(passkeys)
		.set({
			counter: result.authenticationInfo.newCounter,
			lastUsedAt: new Date(),
		})
		.where(
			and(eq(passkeys.id, passkey.id), eq(passkeys.counter, passkey.counter)),
		)
		.returning({ id: passkeys.id });
	if (updated.length === 0)
		throw new AuthError("Sign-in couldn't be verified; try again");
	return createSession(db, passkey.id);
}
