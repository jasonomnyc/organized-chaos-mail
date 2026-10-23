import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { readJson, writeJson } from "./secureStore.js";
import { loginPage } from "./auth/pages.js";

/**
 * Locks the connector to its owner. Claude registers itself (dynamic client
 * registration), then sends the owner to /authorize, where they type the
 * OWNER_PASSWORD set when the server was deployed. Only then does Claude get
 * an access token. Tokens are stored hashed.
 */
const ACCESS_TTL_S = 60 * 60; // 1 hour
const REFRESH_TTL_S = 180 * 24 * 60 * 60; // 180 days, renewed on every use
const CODE_TTL_MS = 5 * 60 * 1000;
const STATE_FILE = "connector-auth.json";

const hash = (t) => createHash("sha256").update(t).digest("hex");
const now = () => Math.floor(Date.now() / 1000);

let state;
async function load() {
    if (!state) state = (await readJson(STATE_FILE)) ?? { clients: {}, access: {}, refresh: {} };
    return state;
}
async function save() {
    const t = now();
    for (const [k, v] of Object.entries(state.access)) if (v.exp < t) delete state.access[k];
    for (const [k, v] of Object.entries(state.refresh)) if (v.exp < t) delete state.refresh[k];
    await writeJson(STATE_FILE, state);
}

export function passwordMatches(input) {
    const want = process.env.OWNER_PASSWORD || "";
    if (want.length < 10) return false; // never allow a missing/short password
    const a = Buffer.from(hash(String(input ?? "")));
    const b = Buffer.from(hash(want));
    return timingSafeEqual(a, b);
}

/** Pending /authorize requests waiting for the password, and issued codes. */
const pendingLogins = new Map();
const codes = new Map();

export class OwnerAuthProvider {
    get clientsStore() {
        return {
            getClient: async (id) => (await load()).clients[id],
            registerClient: async (client) => {
                const s = await load();
                const full = { ...client, client_id: randomUUID(), client_id_issued_at: now() };
                s.clients[full.client_id] = full;
                await save();
                return full;
            },
        };
    }

    async authorize(client, params, res) {
        const loginId = randomBytes(16).toString("hex");
        pendingLogins.set(loginId, { clientId: client.client_id, params, at: Date.now(), tries: 0 });
        for (const [k, v] of pendingLogins) if (Date.now() - v.at > 15 * 60 * 1000) pendingLogins.delete(k);
        res.setHeader("Content-Type", "text/html");
        res.end(loginPage({ action: "/login", loginId, clientName: client.client_name }));
    }

    /** POST /login from the password page. */
    async completeLogin(loginId, password, res) {
        const pending = pendingLogins.get(loginId);
        if (!pending) {
            res.status(400).type("html").end(loginPage({ expired: true }));
            return;
        }
        if (!passwordMatches(password)) {
            pending.tries += 1;
            if (pending.tries >= 5) pendingLogins.delete(loginId);
            await new Promise((r) => setTimeout(r, 1000));
            res.status(401).type("html").end(loginPage({ action: "/login", loginId, error: pending.tries >= 5 ? "Too many tries. Start the connection again from Claude." : "That password isn't right." }));
            return;
        }
        pendingLogins.delete(loginId);
        const code = randomBytes(32).toString("hex");
        codes.set(code, { clientId: pending.clientId, params: pending.params, at: Date.now() });
        const target = new URL(pending.params.redirectUri);
        target.searchParams.set("code", code);
        if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
        res.redirect(target.toString());
    }

    async challengeForAuthorizationCode(client, code) {
        const entry = codes.get(code);
        if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
        return entry.params.codeChallenge;
    }

    async exchangeAuthorizationCode(client, code) {
        const entry = codes.get(code);
        codes.delete(code);
        if (!entry || entry.clientId !== client.client_id || Date.now() - entry.at > CODE_TTL_MS) {
            throw new InvalidGrantError("Invalid or expired authorization code");
        }
        return this.#issue(client.client_id, entry.params.scopes ?? []);
    }

    async exchangeRefreshToken(client, refreshToken) {
        const s = await load();
        const key = hash(refreshToken);
        const entry = s.refresh[key];
        if (!entry || entry.clientId !== client.client_id || entry.exp < now()) {
            throw new InvalidGrantError("Invalid refresh token");
        }
        delete s.refresh[key];
        return this.#issue(client.client_id, entry.scopes);
    }

    async #issue(clientId, scopes) {
        const s = await load();
        const access = randomBytes(32).toString("hex");
        const refresh = randomBytes(32).toString("hex");
        s.access[hash(access)] = { clientId, scopes, exp: now() + ACCESS_TTL_S };
        s.refresh[hash(refresh)] = { clientId, scopes, exp: now() + REFRESH_TTL_S };
        await save();
        return {
            access_token: access,
            token_type: "bearer",
            expires_in: ACCESS_TTL_S,
            refresh_token: refresh,
            scope: scopes.join(" "),
        };
    }

    async verifyAccessToken(token) {
        const s = await load();
        const entry = s.access[hash(token)];
        if (!entry || entry.exp < now()) throw new InvalidTokenError("Invalid or expired token");
        return { token, clientId: entry.clientId, scopes: entry.scopes, expiresAt: entry.exp };
    }

    async revokeToken(client, { token }) {
        const s = await load();
        delete s.access[hash(token)];
        delete s.refresh[hash(token)];
        await save();
    }

    /** Signs out every Claude connection (used by the "sign out everywhere" button). */
    async revokeAll() {
        const s = await load();
        s.access = {};
        s.refresh = {};
        await save();
    }
}
