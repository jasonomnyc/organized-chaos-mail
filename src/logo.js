import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { ok, safe } from "./tools.js";

/**
 * Finds a company's logo from its web domain, for the inbox logos in Organized Chaos.
 * Order: the site's own apple-touch-icon or large declared icons, Google's favicon service at 128 px,
 * then /favicon.ico. Only public https addresses are fetched.
 */
const MAX_BYTES = 600 * 1024;
const UA = "Mozilla/5.0 (compatible; OrganizedChaosMail/1.0; +logo lookup)";

async function publicHost(host) {
    const h = host.replace(/^\[|\]$/g, "");
    const addrs = isIP(h) ? [{ address: h }] : await lookup(h, { all: true });
    for (const { address } of addrs) {
        if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address) ||
            /^(::1|fc|fd|fe80)/i.test(address)) throw new Error("private address");
    }
}

async function get(url, accept) {
    let u = new URL(url);
    for (let hop = 0; hop < 4; hop++) {
        if (u.protocol !== "https:") throw new Error("not https");
        await publicHost(u.hostname);
        const res = await fetch(u, { redirect: "manual", headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(8000) });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { u = new URL(res.headers.get("location"), u); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get("content-length") || 0);
        if (len > MAX_BYTES * 4) throw new Error("too large");
        const buf = Buffer.from(await res.arrayBuffer());
        return { buf, type: (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), url: u.href };
    }
    throw new Error("too many redirects");
}

function sniff(buf, type) {
    if (buf.length < 8) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
    if (buf.slice(0, 4).toString() === "GIF8") return "image/gif";
    if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
    if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return "image/x-icon";
    const head = buf.slice(0, 300).toString("utf8").trimStart().toLowerCase();
    if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")) || type === "image/svg+xml") return "image/svg+xml";
    return null;
}
function pngSize(buf) { return buf[0] === 0x89 && buf.length > 24 ? buf.readUInt32BE(16) : 0; }

/** Icons the home page declares, best first. */
function declaredIcons(html, base) {
    const out = [];
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
        const tag = m[0];
        const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
        if (!/\b(icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)\b/.test(rel)) continue;
        if (/mask-icon/.test(rel)) continue; // one-color silhouettes
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
        if (!href || href.startsWith("data:")) continue;
        const sizes = /\bsizes\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] ?? "";
        const px = Math.max(0, ...sizes.split(/\s+/).map((s) => Number(s.split("x")[0]) || (s === "any" ? 512 : 0)));
        let url;
        try { url = new URL(href, base).href; } catch { continue; }
        const score = (/apple-touch/.test(rel) ? 1000 : 0) + (px || (/\.svg(\?|$)/i.test(href) ? 400 : 16));
        out.push({ url, score });
    }
    return out.sort((a, b) => b.score - a.score);
}

export async function findLogo(domainIn) {
    const domain = String(domainIn || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new Error("Give a web domain like example.com.");
    const tried = [];
    const candidates = [];
    for (const host of [domain, `www.${domain}`]) {
        try {
            const page = await get(`https://${host}/`, "text/html");
            if (/html/.test(page.type) || !page.type) candidates.push(...declaredIcons(page.buf.toString("utf8").slice(0, 400_000), page.url));
            candidates.push({ url: new URL("/apple-touch-icon.png", page.url).href, score: 900 });
            break;
        } catch (err) { tried.push(`${host}: ${err.message}`); }
    }
    candidates.push({ url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`, score: 300, google: true });
    candidates.push({ url: `https://${domain}/favicon.ico`, score: 10 });
    const seen = new Set();
    let fallback = null;
    for (const c of candidates.sort((a, b) => b.score - a.score)) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        try {
            const r = await get(c.url, "image/*");
            const mime = sniff(r.buf, r.type);
            if (!mime || r.buf.length > MAX_BYTES) continue;
            const px = pngSize(r.buf);
            const hit = { domain, mime_type: mime, content_base64: r.buf.toString("base64"), source_url: r.url, width: px || null };
            // A tiny picture is kept only if nothing better turns up.
            if (mime === "image/png" && px && px < 48) { fallback ??= hit; continue; }
            if (mime === "image/x-icon") { fallback ??= hit; continue; }
            return hit;
        } catch (err) { tried.push(`${c.url}: ${err.message}`); }
    }
    if (fallback) return fallback;
    throw new Error(`No logo found for ${domain}.`);
}

export function registerLogoTools(server) {
    server.registerTool("get_logo", {
        title: "Find a company's logo",
        description: "Look up a company's logo or site icon from its web domain (for example the part after @ in an email address). " +
            "Returns the picture base64-encoded. Used to give inboxes a logo automatically.",
        inputSchema: { domain: z.string().describe('A web domain, e.g. "example.com".') },
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, safe(async ({ domain }) => ok(await findLogo(domain))));
}
