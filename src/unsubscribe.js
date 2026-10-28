import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { findAccount, loadConfig, requirePermission } from "./config.js";
import { providerFor } from "./providers/index.js";
import { inbox, ok, safe } from "./tools.js";

/**
 * Unsubscribing without a browser, using the List-Unsubscribe header that mailing lists put on their emails.
 * - One-click (RFC 8058): this server sends the POST itself. Nothing to open.
 * - An unsubscribe address: an unsubscribe email is sent from the inbox.
 * - Only a web page: nothing can be done automatically; the link is handed back.
 */

/** The List-Unsubscribe headers of one email. */
async function listHeaders(account, mail, emailId) {
    if (account.provider === "icloud") return mail.headers(emailId);
    if (account.provider === "gmail") {
        const msg = await mail.call(`/messages/${encodeURIComponent(emailId)}`, {
            params: { format: "metadata", metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post", "From", "Subject"] },
        });
        const h = {};
        for (const x of msg.payload?.headers ?? []) h[x.name.toLowerCase()] ??= x.value;
        return h;
    }
    const msg = await mail.call(`/messages/${encodeURIComponent(emailId)}`, { params: { $select: "internetMessageHeaders,subject,from" } });
    const h = {};
    for (const x of msg.internetMessageHeaders ?? []) h[x.name.toLowerCase()] ??= x.value;
    return h;
}

function parseTargets(value) {
    const out = { https: [], mailto: [] };
    for (const m of String(value || "").matchAll(/<([^>]+)>/g)) {
        const t = m[1].trim();
        if (/^https:\/\//i.test(t)) out.https.push(t);
        else if (/^mailto:/i.test(t)) out.mailto.push(t);
    }
    return out;
}

/** Refuses addresses inside private networks, so a crafted email can't make the server call itself or its neighbours. */
async function publicUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== "https:") throw new Error("not https");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    for (const { address } of addrs) {
        if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address) ||
            /^(::1|fc|fd|fe80)/i.test(address)) throw new Error("private address");
    }
    return url;
}

async function oneClick(target) {
    const url = await publicUrl(target);
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "OrganizedChaosMail/1.0" },
        body: "List-Unsubscribe=One-Click",
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
    });
    // 2xx is success; many lists answer a one-click POST with a redirect to a "you're unsubscribed" page.
    if (res.status >= 200 && res.status < 400) return res.status;
    throw new Error(`the list answered ${res.status}`);
}

function mailtoParts(target) {
    const u = new URL(target);
    const to = decodeURIComponent(u.pathname);
    return { to, subject: u.searchParams.get("subject") || "unsubscribe", body: u.searchParams.get("body") || "unsubscribe" };
}

export function registerUnsubscribeTools(server) {
    server.registerTool("unsubscribe", {
        title: "Unsubscribe from a mailing list",
        description: "Unsubscribe the inbox from the mailing list an email came from, using the list's own unsubscribe " +
            "header: a one-click request, or an unsubscribe email sent from this inbox. Can also archive the email. " +
            "If the list only offers a web page, nothing is done and the page link is returned.",
        inputSchema: {
            inbox,
            email_id: z.string(),
            archive: z.boolean().optional().describe("Also archive this email."),
        },
        annotations: { openWorldHint: true },
    }, safe(async ({ inbox: nick, email_id, archive }) => {
        const config = await loadConfig();
        const account = findAccount(config, nick);
        requirePermission(config, account, "send", "unsubscribe from mailing lists");
        const mail = await providerFor(config, account);
        const h = await listHeaders(account, mail, email_id);
        const t = parseTargets(h["list-unsubscribe"]);
        const canOneClick = /one-click/i.test(h["list-unsubscribe-post"] || "") && t.https.length > 0;
        let done = null, lastErr = null;
        if (canOneClick) {
            for (const u of t.https) {
                try { await oneClick(u); done = { method: "one_click" }; break; } catch (err) { lastErr = err; }
            }
        }
        if (!done && t.mailto.length) {
            try {
                const m = mailtoParts(t.mailto[0]);
                await mail.send({ to: [m.to], subject: m.subject, body: m.body });
                done = { method: "email", to: m.to };
            } catch (err) { lastErr = err; }
        }
        if (done && archive) {
            try { await mail.update(email_id, { archive: true, read: true, starred: false }); done.archived = true; } catch { done.archived = false; }
        }
        if (done) return ok({ unsubscribed: true, ...done });
        return ok({
            unsubscribed: false,
            reason: t.https.length || t.mailto.length ? `The list's unsubscribe didn't go through${lastErr ? ": " + (lastErr.message || lastErr) : ""}.`
                : "This email has no unsubscribe header.",
            link: t.https[0] || undefined,
        });
    }));
}
