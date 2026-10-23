import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { readJson, writeJson, removeFile } from "./secureStore.js";
import { baseUrl } from "./auth/appKeys.js";
import { ok, safe } from "./tools.js";

/**
 * Several Slack workspaces (yours and clients'), each signed in once as you.
 * Uses a user token, so Claude reads what you can read and sends as you.
 * Each workspace has its own permission: read, draft (same as read for Slack,
 * since Slack has no drafts) or send.
 */
const USER_SCOPES = [
    "channels:history", "channels:read", "groups:history", "groups:read",
    "im:history", "im:read", "im:write", "mpim:history", "mpim:read", "mpim:write",
    "users:read", "users:read.email", "search:read", "chat:write",
];
const STORE = "slack.json";
const RANK = { read: 0, draft: 1, send: 2 };
const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;

export function slackRedirectUri() {
    return `${baseUrl()}/oauth/slack/callback`;
}

function slackKeys() {
    const clientId = process.env.SLACK_CLIENT_ID, clientSecret = process.env.SLACK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error("Slack isn't set up on this server yet: add SLACK_CLIENT_ID and SLACK_CLIENT_SECRET (see the setup guide).");
    }
    return { clientId, clientSecret };
}

async function loadStore() {
    return (await readJson(STORE)) ?? { permission: "read", workspaces: [] };
}
async function saveStore(s) {
    await writeJson(STORE, s);
}
const tokenFile = (id) => `tokens/slack-${id}.json`;

function findWorkspace(store, nickname) {
    const w = store.workspaces.find((x) => x.nickname.toLowerCase() === String(nickname).toLowerCase());
    if (!w) {
        const known = store.workspaces.map((x) => `"${x.nickname}"`).join(", ") || "none yet";
        throw new Error(`No Slack workspace called "${nickname}". Connected: ${known}.`);
    }
    return w;
}
const permOf = (store, w) => w.permission ?? store.permission ?? "read";
function need(store, w, level, action) {
    const have = permOf(store, w);
    if (RANK[have] < RANK[level]) {
        throw new Error(`Can't ${action}: the "${w.nickname}" Slack workspace is set to "${have}" access, and this needs "${level}".`);
    }
}

/* ---------- sign-in ---------- */
const waiting = new Map();
export function startSlackSignIn(nickname, description) {
    const { clientId } = slackKeys();
    const state = randomBytes(16).toString("hex");
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("user_scope", USER_SCOPES.join(","));
    url.searchParams.set("redirect_uri", slackRedirectUri());
    url.searchParams.set("state", state);
    const timer = setTimeout(() => waiting.delete(state), SIGN_IN_TIMEOUT_MS);
    timer.unref?.();
    waiting.set(state, { nickname, description, timer });
    return url.toString();
}

async function slackForm(method, params) {
    const res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
    });
    const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
    if (!data.ok) throw new Error(`Slack said: ${data.error || "unknown error"}`);
    return data;
}

export async function finishSlackSignIn(params) {
    const state = params.get("state") ?? "";
    const entry = waiting.get(state);
    if (!entry) throw new Error("This sign-in link expired or was already used. Ask Claude to add the workspace again.");
    waiting.delete(state);
    clearTimeout(entry.timer);
    if (params.get("error")) throw new Error(params.get("error") === "access_denied" ? "Access was not granted." : params.get("error"));
    const { clientId, clientSecret } = slackKeys();
    const data = await slackForm("oauth.v2.access", {
        client_id: clientId, client_secret: clientSecret, code: params.get("code") ?? "", redirect_uri: slackRedirectUri(),
    });
    const user = data.authed_user || {};
    if (!user.access_token) throw new Error("Slack didn't return a sign-in for your user.");
    const store = await loadStore();
    const teamId = data.team?.id;
    let w = store.workspaces.find((x) => x.teamId === teamId && x.userId === user.id);
    if (!w) {
        if (store.workspaces.some((x) => x.nickname.toLowerCase() === entry.nickname.toLowerCase())) {
            throw new Error(`There's already a Slack workspace called "${entry.nickname}".`);
        }
        w = { id: randomUUID(), nickname: entry.nickname, teamId, userId: user.id };
        store.workspaces.push(w);
    }
    w.teamName = data.team?.name || w.teamName || "";
    if (entry.description !== undefined) w.description = entry.description;
    await writeJson(tokenFile(w.id), {
        access_token: user.access_token,
        refresh_token: user.refresh_token || null,
        expires_at: user.expires_in ? Date.now() + user.expires_in * 1000 : null,
    });
    await saveStore(store);
    return w;
}

/* ---------- API calls as you ---------- */
async function tokenFor(w) {
    const t = await readJson(tokenFile(w.id));
    if (!t?.access_token) throw new Error(`The "${w.nickname}" Slack workspace needs to be signed in again. Remove it and add it back.`);
    // Only when token rotation is switched on in the Slack app do tokens expire.
    if (t.expires_at && t.refresh_token && Date.now() > t.expires_at - 5 * 60 * 1000) {
        const { clientId, clientSecret } = slackKeys();
        const r = await slackForm("oauth.v2.access", { client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: t.refresh_token });
        const fresh = { access_token: r.access_token, refresh_token: r.refresh_token || t.refresh_token, expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : null };
        await writeJson(tokenFile(w.id), fresh);
        return fresh.access_token;
    }
    return t.access_token;
}

async function api(w, method, params = {}, post = false) {
    const token = await tokenFor(w);
    for (let attempt = 0; ; attempt++) {
        const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
        const res = post
            ? await fetch(`https://slack.com/api/${method}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify(clean),
            })
            : await fetch(`https://slack.com/api/${method}?${new URLSearchParams(clean)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 429 && attempt < 3) {
            const wait = Number(res.headers.get("retry-after") || 2);
            await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
            continue;
        }
        const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
        if (!data.ok) {
            const e = data.error || "unknown error";
            if (["invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired"].includes(e)) {
                throw new Error(`The "${w.nickname}" Slack workspace needs to be signed in again (${e}). Remove it and add it back.`);
            }
            if (e === "missing_scope") throw new Error(`The Slack app is missing a permission (${data.needed || "unknown"}). Add it in the Slack app settings, then reconnect "${w.nickname}".`);
            throw new Error(`Slack (${w.nickname}) said: ${e}`);
        }
        return data;
    }
}

/* Names for people and channels, cached per workspace for 10 minutes. */
const cache = new Map();
function wsCache(w) {
    let c = cache.get(w.id);
    if (!c || Date.now() - c.at > 10 * 60 * 1000) {
        c = { at: Date.now(), users: new Map(), chans: null };
        cache.set(w.id, c);
    }
    return c;
}
async function userName(w, id) {
    if (!id) return "";
    const c = wsCache(w);
    if (!c.users.has(id)) {
        c.users.set(id, api(w, "users.info", { user: id })
            .then((r) => ({ name: r.user?.profile?.real_name || r.user?.real_name || r.user?.name || id, email: r.user?.profile?.email || "" }))
            .catch(() => ({ name: id, email: "" })));
    }
    return c.users.get(id);
}
async function conversations(w) {
    const c = wsCache(w);
    if (!c.chans) {
        c.chans = (async () => {
            const out = [];
            let cursor;
            for (let p = 0; p < 20; p++) {
                const r = await api(w, "users.conversations", { types: "public_channel,private_channel,mpim,im", exclude_archived: true, limit: 200, cursor });
                out.push(...(r.channels || []));
                cursor = r.response_metadata?.next_cursor;
                if (!cursor) break;
            }
            return out;
        })();
        c.chans.catch(() => { c.chans = null; });
    }
    return c.chans;
}
async function convLabel(w, ch) {
    if (ch.is_im) return `DM with ${(await userName(w, ch.user)).name}`;
    if (ch.is_mpim) return `Group DM (${ch.name || ch.id})`;
    return `#${ch.name}`;
}
/** Accepts a channel id, "#name", "name", "@person", a person's email, or a DM partner's name. */
async function resolveChannel(w, target) {
    const t = String(target || "").trim();
    if (!t) throw new Error("Say which channel or person.");
    if (/^[CDG][A-Z0-9]{6,}$/.test(t)) return t;
    const chans = await conversations(w);
    const bare = t.replace(/^#/, "").toLowerCase();
    if (!t.startsWith("@") && !t.includes("@")) {
        const ch = chans.find((c) => !c.is_im && (c.name || "").toLowerCase() === bare);
        if (ch) return ch.id;
    }
    // A person: by email, @handle or name → open (or find) the DM.
    const who = t.replace(/^@/, "").toLowerCase();
    let userId = null;
    if (who.includes("@")) {
        const r = await api(w, "users.lookupByEmail", { email: who }).catch(() => null);
        userId = r?.user?.id || null;
    }
    if (!userId) {
        for (const c of chans.filter((x) => x.is_im)) {
            const u = await userName(w, c.user);
            if (u.name.toLowerCase() === who || u.email.toLowerCase() === who) return c.id;
        }
        let cursor;
        for (let p = 0; p < 10 && !userId; p++) {
            const r = await api(w, "users.list", { limit: 200, cursor });
            const m = (r.members || []).find((u) => !u.deleted && [u.name, u.real_name, u.profile?.display_name, u.profile?.real_name].some((n) => (n || "").toLowerCase() === who));
            if (m) userId = m.id;
            cursor = r.response_metadata?.next_cursor;
            if (!cursor) break;
        }
    }
    if (!userId) throw new Error(`Couldn't find a channel or person called "${t}" in ${w.nickname}.`);
    const open = await api(w, "conversations.open", { users: userId }, true);
    return open.channel.id;
}

/** Slack's markup (<@U1>, <#C1|name>, <url|text>) as plain readable text. */
async function plainText(w, text) {
    let s = String(text || "");
    const ids = [...new Set([...s.matchAll(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g)].map((m) => m[1]))];
    for (const id of ids) s = s.replaceAll(new RegExp(`<@${id}(\\|[^>]*)?>`, "g"), "@" + (await userName(w, id)).name);
    return s.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1").replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)").replace(/<(https?:[^>]+)>/g, "$1")
        .replace(/<!(here|channel|everyone)>/g, "@$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
async function shapeMessage(w, m, channelLabel) {
    const who = m.user ? await userName(w, m.user) : { name: m.username || m.bot_profile?.name || "app", email: "" };
    return {
        ts: m.ts, when: new Date(Number(m.ts) * 1000).toISOString(), from: who.name, from_email: who.email || undefined,
        text: (await plainText(w, m.text)).slice(0, 4000), thread_ts: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined,
        replies: m.reply_count || undefined, channel: channelLabel, files: (m.files || []).map((f) => f.name).filter(Boolean).slice(0, 10),
    };
}
const sinceTs = (minutes) => String(Math.floor((Date.now() - minutes * 60000) / 1000));

/* ---------- tools ---------- */
const workspace = z.string().describe('The Slack workspace nickname, as shown by slack_list_workspaces.');
function targets(store, nickname) {
    if (!store.workspaces.length) throw new Error("No Slack workspaces are connected yet. Use slack_add_workspace first.");
    return !nickname || nickname.toLowerCase() === "all" ? store.workspaces : [findWorkspace(store, nickname)];
}

export function registerSlackTools(server) {
    server.registerTool("slack_list_workspaces", {
        title: "List Slack workspaces",
        description: "List every connected Slack workspace with its nickname, team name, description and permission (read or send).",
        inputSchema: {}, annotations: { readOnlyHint: true },
    }, safe(async () => {
        const s = await loadStore();
        return ok({
            default_permission: s.permission || "read",
            workspaces: s.workspaces.map((w) => ({ nickname: w.nickname, team: w.teamName, description: w.description, permission: permOf(s, w) })),
        });
    }));

    server.registerTool("slack_add_workspace", {
        title: "Connect a Slack workspace",
        description: "Connect a Slack workspace as the person (their own or a client's). Returns a sign-in link to give them; it works on a phone or computer and expires in 15 minutes.",
        inputSchema: {
            nickname: z.string().describe('A short name, like "OM" or "Abbey".'),
            description: z.string().optional().describe("What this workspace is for."),
        },
    }, safe(async ({ nickname, description }) => {
        const name = nickname.trim();
        if (!name || name.length > 40 || name.toLowerCase() === "all") throw new Error('Pick a nickname of 1 to 40 characters (not "all").');
        const s = await loadStore();
        if (s.workspaces.some((w) => w.nickname.toLowerCase() === name.toLowerCase())) throw new Error(`There's already a Slack workspace called "${name}".`);
        const url = startSlackSignIn(name, description);
        return ok(`To connect "${name}", open this link, pick the workspace at the top right of Slack's page, and click Allow:\n${url}\n` +
            "If the workspace only allows approved apps, Slack sends a request to its admin instead. Once done, call slack_list_workspaces to confirm.");
    }));

    server.registerTool("slack_update_workspace", {
        title: "Rename or change a Slack workspace's settings",
        description: 'Change a workspace\'s nickname, description or permission ("read", "send", or "default"). Only change the permission when the person asks.',
        inputSchema: {
            workspace, new_nickname: z.string().optional(), description: z.string().optional(),
            permission: z.enum(["read", "send", "default"]).optional(),
        }, annotations: { idempotentHint: true },
    }, safe(async ({ workspace: nick, new_nickname, description, permission }) => {
        const s = await loadStore();
        const w = findWorkspace(s, nick);
        if (new_nickname !== undefined) {
            const n = new_nickname.trim();
            if (!n || n.toLowerCase() === "all") throw new Error("That nickname can't be used.");
            if (s.workspaces.some((x) => x !== w && x.nickname.toLowerCase() === n.toLowerCase())) throw new Error(`There's already one called "${n}".`);
            w.nickname = n;
        }
        if (description !== undefined) w.description = description.trim() || undefined;
        if (permission === "default") delete w.permission; else if (permission) w.permission = permission;
        await saveStore(s);
        return ok({ nickname: w.nickname, description: w.description, permission: permOf(s, w) });
    }));

    server.registerTool("slack_remove_workspace", {
        title: "Disconnect a Slack workspace",
        description: "Disconnect a Slack workspace and delete its saved sign-in from this server. Nothing in Slack is deleted.",
        inputSchema: { workspace },
    }, safe(async ({ workspace: nick }) => {
        const s = await loadStore();
        const w = findWorkspace(s, nick);
        s.workspaces = s.workspaces.filter((x) => x !== w);
        await saveStore(s);
        await removeFile(tokenFile(w.id));
        cache.delete(w.id);
        return ok(`Disconnected "${w.nickname}".`);
    }));

    server.registerTool("slack_activity", {
        title: "What needs you in Slack",
        description: "New direct messages, group DMs and @mentions of you since a given time, across one or all workspaces. Use for alerts and digests.",
        inputSchema: {
            workspace: workspace.optional().describe('A nickname, or "all" (the default).'),
            since_minutes: z.number().int().min(1).max(7 * 24 * 60).optional().describe("How far back to look. Default 70 minutes."),
        }, annotations: { readOnlyHint: true },
    }, safe(async ({ workspace: nick, since_minutes }) => {
        const s = await loadStore();
        const mins = since_minutes ?? 70;
        const oldest = sinceTs(mins);
        const results = await Promise.all(targets(s, nick).map(async (w) => {
            try {
                const chans = await conversations(w);
                const dms = chans.filter((c) => c.is_im || c.is_mpim);
                const out = [];
                // Direct and group messages from other people.
                for (let i = 0; i < dms.length; i += 8) {
                    const batch = await Promise.all(dms.slice(i, i + 8).map(async (c) => {
                        const r = await api(w, "conversations.history", { channel: c.id, oldest, limit: 30 }).catch(() => ({ messages: [] }));
                        const label = await convLabel(w, c);
                        return Promise.all((r.messages || []).filter((m) => m.user && m.user !== w.userId && !m.subtype)
                            .map((m) => shapeMessage(w, { ...m }, label).then((x) => ({ ...x, kind: c.is_im ? "dm" : "group_dm", channel_id: c.id }))));
                    }));
                    out.push(...batch.flat());
                }
                // @mentions in channels (found through search, which covers every channel you're in).
                const after = new Date(Date.now() - mins * 60000 - 864e5).toISOString().slice(0, 10);
                const sr = await api(w, "search.messages", { query: `<@${w.userId}> after:${after}`, sort: "timestamp", sort_dir: "desc", count: 50 }).catch(() => null);
                for (const m of sr?.messages?.matches || []) {
                    if (Number(m.ts) < Number(oldest) || m.user === w.userId || !String(m.text || "").includes(`<@${w.userId}>`)) continue;
                    if (m.channel?.is_im || m.channel?.is_mpim) continue;
                    out.push({ ...(await shapeMessage(w, m, m.channel?.name ? `#${m.channel.name}` : "a channel")), kind: "mention", channel_id: m.channel?.id, link: m.permalink });
                }
                out.sort((a, b) => Number(b.ts) - Number(a.ts));
                return { workspace: w.nickname, items: out };
            }
            catch (err) {
                return { workspace: w.nickname, error: err.message };
            }
        }));
        return ok({ since: new Date(Number(oldest) * 1000).toISOString(), results });
    }));

    server.registerTool("slack_search", {
        title: "Search Slack",
        description: "Search messages in one or all workspaces. Slack search syntax works: from:@name, in:#channel, after:2026-10-01, has:link, quoted phrases.",
        inputSchema: {
            query: z.string(), workspace: workspace.optional().describe('A nickname, or "all" (the default).'),
            max_results: z.number().int().min(1).max(50).optional(),
        }, annotations: { readOnlyHint: true },
    }, safe(async ({ query, workspace: nick, max_results }) => {
        const s = await loadStore();
        const results = await Promise.all(targets(s, nick).map(async (w) => {
            try {
                const r = await api(w, "search.messages", { query, sort: "timestamp", sort_dir: "desc", count: max_results ?? 20 });
                const matches = await Promise.all((r.messages?.matches || []).map(async (m) => ({
                    ...(await shapeMessage(w, m, m.channel?.is_im ? "a DM" : m.channel?.name ? `#${m.channel.name}` : "")), channel_id: m.channel?.id, link: m.permalink,
                })));
                return { workspace: w.nickname, total: r.messages?.total ?? matches.length, matches };
            }
            catch (err) {
                return { workspace: w.nickname, error: err.message };
            }
        }));
        return ok(results);
    }));

    server.registerTool("slack_list_channels", {
        title: "List channels and DMs",
        description: "List the channels, private channels and DMs you're in for one workspace.",
        inputSchema: { workspace, include_dms: z.boolean().optional().describe("Also list DMs (default true).") },
        annotations: { readOnlyHint: true },
    }, safe(async ({ workspace: nick, include_dms }) => {
        const s = await loadStore();
        const w = findWorkspace(s, nick);
        const chans = (await conversations(w)).filter((c) => include_dms !== false || !(c.is_im || c.is_mpim));
        const out = [];
        for (const c of chans.slice(0, 400)) out.push({ id: c.id, name: await convLabel(w, c), private: !!c.is_private, kind: c.is_im ? "dm" : c.is_mpim ? "group_dm" : "channel" });
        return ok({ workspace: w.nickname, channels: out, truncated: chans.length > 400 || undefined });
    }));

    server.registerTool("slack_read", {
        title: "Read a channel, DM or thread",
        description: "Read recent messages in a channel or DM (newest last), or a whole thread when thread_ts is given. The channel can be an id, #name, or a person (email or name) for your DM with them.",
        inputSchema: {
            workspace, channel: z.string(), thread_ts: z.string().optional(),
            limit: z.number().int().min(1).max(100).optional().describe("How many messages. Default 30."),
            since_minutes: z.number().int().min(1).optional(),
        }, annotations: { readOnlyHint: true },
    }, safe(async ({ workspace: nick, channel, thread_ts, limit, since_minutes }) => {
        const s = await loadStore();
        const w = findWorkspace(s, nick);
        const id = await resolveChannel(w, channel);
        const r = thread_ts
            ? await api(w, "conversations.replies", { channel: id, ts: thread_ts, limit: limit ?? 50 })
            : await api(w, "conversations.history", { channel: id, limit: limit ?? 30, oldest: since_minutes ? sinceTs(since_minutes) : undefined });
        const ch = (await conversations(w)).find((c) => c.id === id);
        const label = ch ? await convLabel(w, ch) : id;
        const msgs = await Promise.all((r.messages || []).map((m) => shapeMessage(w, m, label)));
        msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
        return ok({ workspace: w.nickname, channel: label, channel_id: id, messages: msgs });
    }));

    server.registerTool("slack_send", {
        title: "Send a Slack message",
        description: "Send a message as the person, to a channel, a DM (person's email or name) or a thread reply. Needs send permission. Confirm the wording and recipient with the person first unless they clearly asked to send without checking.",
        inputSchema: {
            workspace, channel: z.string().describe("Channel id, #name, or a person (email or name) to DM."),
            text: z.string(), thread_ts: z.string().optional().describe("Reply in this thread."),
        }, annotations: { destructiveHint: true, openWorldHint: true },
    }, safe(async ({ workspace: nick, channel, text, thread_ts }) => {
        const s = await loadStore();
        const w = findWorkspace(s, nick);
        need(s, w, "send", "send Slack messages");
        const id = await resolveChannel(w, channel);
        const r = await api(w, "chat.postMessage", { channel: id, text, thread_ts }, true);
        return ok({ sent: true, workspace: w.nickname, channel_id: id, ts: r.ts });
    }));
}

export async function slackSummary() {
    const s = await loadStore();
    return s.workspaces.length;
}
