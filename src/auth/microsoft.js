import { randomBytes } from "node:crypto";
import { CryptoProvider, InteractionRequiredAuthError, PublicClientApplication, } from "@azure/msal-node";
import { baseUrl, microsoftClientId } from "./appKeys.js";
import { readToken, writeToken } from "./tokenStore.js";

/** Read, organize, draft and send mail. User.Read gives the address. */
export const MAIL_SCOPES = ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"];
/** See and change events, send invites, and answer them. */
export const CALENDAR_SCOPES = ["Calendars.ReadWrite"];
const SIGN_IN_SCOPES = [...MAIL_SCOPES, ...CALENDAR_SCOPES];
const CACHE_NAME = "microsoft-cache";
const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;

export function microsoftRedirectUri() {
    return `${baseUrl()}/oauth/microsoft/callback`;
}

/** One shared MSAL token cache (encrypted) for every Microsoft inbox — same format as the desktop version. */
const cachePlugin = {
    async beforeCacheAccess(ctx) {
        const data = await readToken(CACHE_NAME);
        if (data) ctx.tokenCache.deserialize(data.cache);
    },
    async afterCacheAccess(ctx) {
        if (ctx.cacheHasChanged) await writeToken(CACHE_NAME, { cache: ctx.tokenCache.serialize() });
    },
};

let app;
let appClientId;
function msalApp(config) {
    const clientId = microsoftClientId(config);
    if (!app || appClientId !== clientId) {
        app = new PublicClientApplication({
            auth: { clientId, authority: "https://login.microsoftonline.com/common" },
            cache: { cachePlugin },
        });
        appClientId = clientId;
    }
    return app;
}

export function resetMicrosoft() {
    app = undefined;
    appClientId = undefined;
}

const crypto = new CryptoProvider();
const waiting = new Map();

/** Starts a web sign-in; Microsoft sends the person back to /oauth/microsoft/callback. */
export function startMicrosoftSignIn(config) {
    const pca = msalApp(config);
    const state = randomBytes(16).toString("hex");
    let entry;
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            waiting.delete(state);
            reject(new Error("Sign-in timed out after 15 minutes."));
        }, SIGN_IN_TIMEOUT_MS);
        entry = { resolve, reject, timer, pca };
    });
    const url = (async () => {
        const { verifier, challenge } = await crypto.generatePkceCodes();
        entry.verifier = verifier;
        waiting.set(state, entry);
        return pca.getAuthCodeUrl({
            scopes: SIGN_IN_SCOPES,
            redirectUri: microsoftRedirectUri(),
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
            prompt: "select_account",
            state,
        });
    })();
    url.catch((err) => entry.reject(err));
    return { url, done };
}

export async function finishMicrosoftSignIn(params) {
    const state = params.get("state") ?? "";
    const entry = waiting.get(state);
    if (!entry) throw new Error("This sign-in link expired or was already used. Ask Claude to add the inbox again.");
    waiting.delete(state);
    clearTimeout(entry.timer);
    try {
        const error = params.get("error");
        if (error) throw new Error(params.get("error_description") || error);
        const result = await entry.pca.acquireTokenByCode({
            code: params.get("code"),
            scopes: SIGN_IN_SCOPES,
            redirectUri: microsoftRedirectUri(),
            codeVerifier: entry.verifier,
        });
        if (!result.account) throw new Error("Microsoft didn't return an account.");
        const value = { email: result.account.username, homeAccountId: result.account.homeAccountId };
        entry.resolve(value);
        return value;
    }
    catch (err) {
        entry.reject(err);
        throw err;
    }
}

/** A current access token for one Microsoft inbox, refreshed silently when needed. */
export async function microsoftToken(config, account, scopes = MAIL_SCOPES) {
    const pca = msalApp(config);
    const msAccount = account.homeAccountId
        ? await pca.getTokenCache().getAccountByHomeId(account.homeAccountId)
        : null;
    const needsSignIn = new Error(`The "${account.nickname}" inbox needs to be signed in again. Remove it and add it back.`);
    if (!msAccount) throw needsSignIn;
    try {
        const result = await pca.acquireTokenSilent({ account: msAccount, scopes });
        return result.accessToken;
    }
    catch (err) {
        if (err instanceof InteractionRequiredAuthError) {
            const blocked = /AADSTS53\d{3}|conditional access/i.test(String(err.message));
            if (blocked) {
                throw new Error(`The "${account.nickname}" inbox's organization blocked access from this server ` +
                    "(a location or device rule set by its IT). The desktop version can still reach it.");
            }
            throw needsSignIn;
        }
        throw err;
    }
}

export async function removeMicrosoftAccount(config, homeAccountId) {
    const pca = msalApp(config);
    const cache = pca.getTokenCache();
    const msAccount = await cache.getAccountByHomeId(homeAccountId);
    if (msAccount) await cache.removeAccount(msAccount);
}
