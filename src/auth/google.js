import { randomBytes } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { baseUrl, googleKeys } from "./appKeys.js";
import { readToken, writeToken } from "./tokenStore.js";

/**
 * Mail: read, label, draft and send, with no permanent deletion.
 * Calendar: see and change events, and answer invites.
 */
export const GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
];
const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;

export function googleRedirectUri() {
    return `${baseUrl()}/oauth/google/callback`;
}

/** Sign-ins waiting for Google to send the person back, keyed by state. */
const waiting = new Map();

/**
 * Starts a web sign-in. The person opens `url` on any device (phone is fine);
 * Google sends them back to /oauth/google/callback, which finishes it.
 */
export async function startGoogleSignIn(config) {
    const { clientId, clientSecret } = googleKeys(config, "web");
    const client = new OAuth2Client({ clientId, clientSecret, redirectUri: googleRedirectUri() });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomBytes(16).toString("hex");
    const url = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent select_account",
        scope: GOOGLE_SCOPES,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: codeChallenge,
        state,
    });
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            waiting.delete(state);
            reject(new Error("Sign-in timed out after 15 minutes."));
        }, SIGN_IN_TIMEOUT_MS);
        waiting.set(state, { client, codeVerifier, resolve, reject, timer });
    });
    return { url, done };
}

/** Called by the web server when Google redirects back. Throws a readable error. */
export async function finishGoogleSignIn(params) {
    const entry = waiting.get(params.get("state") ?? "");
    if (!entry) throw new Error("This sign-in link expired or was already used. Ask Claude to add the inbox again.");
    waiting.delete(params.get("state"));
    clearTimeout(entry.timer);
    try {
        const error = params.get("error");
        if (error) throw new Error(error === "access_denied" ? "Access was not granted." : error);
        const { tokens } = await entry.client.getToken({ code: params.get("code"), codeVerifier: entry.codeVerifier });
        if (!tokens.refresh_token) throw new Error("Google didn't return a long-lived sign-in.");
        entry.client.setCredentials(tokens);
        const profile = await entry.client.request({
            url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        });
        const value = { email: profile.data.emailAddress, tokens: { ...tokens, oc_client: "web" } };
        entry.resolve(value);
        return value;
    }
    catch (err) {
        entry.reject(err);
        throw err;
    }
}

const clients = new Map();
/** An authorized client for one Gmail inbox; refreshed tokens are saved automatically. */
export async function googleClient(config, account) {
    const cached = clients.get(account.id);
    if (cached) return cached;
    const tokens = await readToken(account.id);
    if (!tokens) {
        throw new Error(`The "${account.nickname}" inbox needs to be signed in again. Remove it and add it back.`);
    }
    // Inboxes imported from the desktop version keep using the desktop app key they were signed in with.
    const which = tokens.oc_client === "web" ? "web" : "desktop";
    const { clientId, clientSecret } = googleKeys(config, which);
    const client = new OAuth2Client({ clientId, clientSecret });
    client.setCredentials(tokens);
    client.on("tokens", (fresh) => {
        const merged = { ...client.credentials, ...fresh, oc_client: which };
        writeToken(account.id, merged).catch(() => { });
    });
    clients.set(account.id, client);
    return client;
}

export function forgetGoogleClient(accountId) {
    clients.delete(accountId);
}

export function forgetAllGoogleClients() {
    clients.clear();
}
