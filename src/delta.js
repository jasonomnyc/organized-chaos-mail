import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Changes-only answers, to keep the server's outgoing data (what Render bills as bandwidth) small.
 *
 * Organized Chaos asks for the same lists every couple of minutes (newest mail per inbox, the calendar, Slack activity).
 * When it sends `delta_token` (the token from its previous answer), the server compares the new answer with the one it
 * sent last time and returns only what changed: {"__oc_delta": {token, base}, patch}. A new email is sent in full; an
 * email that didn't change is sent as a short reference to its id; a quiet refresh is a few bytes.
 *
 * Callers that don't send `delta_token` (Claude itself, older versions of the app) get the normal full answer.
 * Previous answers are kept in memory only, for 45 minutes; after a restart the next answer is simply sent in full.
 * The patch format is mirrored exactly by applyPatch() in Organized Chaos.
 */
export const DELTA_TOOLS = new Set(["search_emails", "list_events", "slack_activity", "list_accounts"]);

const KEEP_MS = 45 * 60 * 1000;
const MAX_ENTRIES = 400;
const kept = new Map(); // token -> { json, at }

function remember(json) {
    const token = randomBytes(12).toString("base64url");
    kept.set(token, { json, at: Date.now() });
    if (kept.size > MAX_ENTRIES || Math.random() < 0.05) {
        const cutoff = Date.now() - KEEP_MS;
        for (const [k, v] of kept) if (v.at < cutoff || kept.size > MAX_ENTRIES) kept.delete(k);
    }
    return token;
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const idOf = (x) => (isObj(x) && (typeof x.id === "string" || typeof x.id === "number") ? String(x.id) : null);
function idList(arr) {
    if (!arr.length) return false;
    const ids = new Set();
    for (const x of arr) { const id = idOf(x); if (id === null || ids.has(id)) return false; ids.add(id); }
    return true;
}

/** What turns `a` into `b`. */
export function makePatch(a, b) {
    if (same(a, b)) return { $s: 1 };
    if (Array.isArray(a) && Array.isArray(b)) {
        if (idList(b) && (idList(a) || !a.length)) {
            const old = new Map(a.map((x) => [idOf(x), x]));
            return { $a: b.map((x) => { const o = old.get(idOf(x)); return o === undefined ? { $n: x } : same(o, x) ? { $r: idOf(x) } : { $p: idOf(x), d: makePatch(o, x) }; }) };
        }
        if (a.length === b.length) return { $e: b.map((x, i) => makePatch(a[i], x)) };
        return { $v: b };
    }
    if (isObj(a) && isObj(b)) {
        const o = {}, x = [];
        for (const k of Object.keys(b)) if (!(k in a) || !same(a[k], b[k])) o[k] = k in a ? makePatch(a[k], b[k]) : { $v: b[k] };
        for (const k of Object.keys(a)) if (!(k in b)) x.push(k);
        return x.length ? { $o: o, $x: x } : { $o: o };
    }
    return { $v: b };
}

/** The inverse of makePatch, used here only to self-check every patch before it is sent. */
export function applyPatch(a, p) {
    if (p.$s) return a;
    if ("$v" in p) return p.$v;
    if (p.$a) { const old = new Map((a || []).map((x) => [idOf(x), x])); return p.$a.map((q) => ("$n" in q ? q.$n : "$r" in q ? old.get(q.$r) : applyPatch(old.get(q.$p), q.d))); }
    if (p.$e) return p.$e.map((q, i) => applyPatch(a[i], q));
    if (p.$o) { const out = { ...a }; for (const k of p.$x || []) delete out[k]; for (const [k, q] of Object.entries(p.$o)) out[k] = applyPatch(a[k], q); return out; }
    throw new Error("bad patch");
}

function wrapHandler(handler) {
    return async (args, extra) => {
        const { delta_token, ...rest } = args ?? {};
        const result = await handler(rest, extra);
        if (delta_token === undefined || result?.isError) return result;
        const text = result?.content?.length === 1 && result.content[0].type === "text" ? result.content[0].text : null;
        let value;
        try { value = JSON.parse(text); } catch { return result; }
        const json = JSON.stringify(value);
        const token = remember(json);
        const prev = delta_token && kept.get(delta_token);
        let body = { __oc_delta: { token }, full: value };
        if (prev) {
            try {
                const before = JSON.parse(prev.json);
                const patch = makePatch(before, value);
                // Only sent when it rebuilds the exact answer and is actually smaller.
                if (JSON.stringify(applyPatch(before, patch)) === json && JSON.stringify(patch).length < json.length) body = { __oc_delta: { token, base: delta_token }, patch };
            } catch { /* fall back to the full answer */ }
        }
        return { content: [{ type: "text", text: JSON.stringify(body) }] };
    };
}

/** Call once on each new McpServer before registering tools: adds the optional delta_token to the list tools. */
export function enableDelta(server) {
    const register = server.registerTool.bind(server);
    server.registerTool = (name, config, handler) => {
        if (!DELTA_TOOLS.has(name)) return register(name, config, handler);
        const inputSchema = {
            ...(config.inputSchema ?? {}),
            delta_token: z.string().max(80).optional().describe("Organized Chaos only: the token from the previous answer, to receive only what changed. Leave empty."),
        };
        return register(name, { ...config, inputSchema }, wrapHandler(handler));
    };
}
