import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import { readToken } from "../auth/tokenStore.js";
import { truncateBody, parseAddressList } from "./types.js";

/**
 * iCloud Mail (and any IMAP/SMTP mailbox) through an app-specific password.
 * Ids are "<mailbox>|<uid>"; a thread is the first Message-ID in a message's References, so replies in the
 * Inbox and in Sent Messages share one thread id. Queries use the same Gmail-style words the app sends
 * (from:, to:, subject:, is:unread, before:/after:<unix seconds or yyyy/mm/dd>, newer_than:30d, plain words).
 */
export const ICLOUD = { imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587 };
const SEP = "|";
const MAX_SCAN = 6000;

export function icloudId(box, uid) { return `${box}${SEP}${uid}`; }
export function splitId(id) {
    const s = String(id ?? "");
    const i = s.lastIndexOf(SEP);
    if (i < 1) throw new Error(`That email id (${s}) isn't from this inbox.`);
    const uid = Number(s.slice(i + 1));
    if (!Number.isInteger(uid) || uid < 1) throw new Error(`That email id (${s}) isn't from this inbox.`);
    return { box: s.slice(0, i), uid };
}

/** Gmail-style search words → an IMAP search plus exact time limits (IMAP dates are whole days). */
export function parseQuery(q) {
    const crit = {}, text = [];
    let afterMs = null, beforeMs = null;
    const when = (v) => {
        if (/^\d{9,11}$/.test(v)) return Number(v) * 1000;
        const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
        if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
        const t = Date.parse(v);
        return Number.isNaN(t) ? null : t;
    };
    const span = (v) => {
        const m = /^(\d+)([dwmy])$/i.exec(v);
        if (!m) return null;
        const n = Number(m[1]), days = { d: 1, w: 7, m: 30, y: 365 }[m[2].toLowerCase()];
        return n * days * 864e5;
    };
    for (const tok of String(q ?? "").match(/(\w+:)?("[^"]*"|\S+)/g) ?? []) {
        const m = /^(\w+):(.*)$/.exec(tok);
        const key = m ? m[1].toLowerCase() : "";
        const val = (m ? m[2] : tok).replace(/^"|"$/g, "");
        if (!val) continue;
        if (!key && /^(and|or)$/i.test(val)) continue;
        if (key === "from") crit.from = val;
        else if (key === "to") crit.to = val;
        else if (key === "cc") crit.cc = val;
        else if (key === "subject") crit.subject = val;
        else if (key === "is" && /^unread$/i.test(val)) crit.seen = false;
        else if (key === "is" && /^read$/i.test(val)) crit.seen = true;
        else if (key === "is" && /^(starred|flagged)$/i.test(val)) crit.flagged = true;
        else if (key === "before" || key === "received<") { const t = when(val); if (t != null) beforeMs = Math.min(beforeMs ?? Infinity, t); }
        else if (key === "after" || key === "since") { const t = when(val); if (t != null) afterMs = Math.max(afterMs ?? -Infinity, t); }
        else if (key === "newer_than") { const s = span(val); if (s) afterMs = Math.max(afterMs ?? -Infinity, Date.now() - s); }
        else if (key === "older_than") { const s = span(val); if (s) beforeMs = Math.min(beforeMs ?? Infinity, Date.now() - s); }
        else if (key === "in" || key === "label" || key === "has" || key === "category") continue;
        else if (/^received[<>]/i.test(tok)) continue;
        else text.push(m ? tok : val);
    }
    // Outlook-style limit the app may also send: received<2026-10-01T00:00:00Z
    const r = /received<(\S+)/.exec(String(q ?? ""));
    if (r) { const t = Date.parse(r[1]); if (!Number.isNaN(t)) beforeMs = Math.min(beforeMs ?? Infinity, t); }
    if (text.length) crit.body = text.join(" ");
    // Whole-day IMAP limits, widened by a day; the exact times are checked against each message.
    if (afterMs != null) crit.since = new Date(afterMs - 864e5);
    if (beforeMs != null) crit.before = new Date(beforeMs + 864e5);
    return { crit, afterMs, beforeMs };
}

function fmtAddr(a) { return a?.name ? `${a.name} <${a.address}>` : a?.address; }
function addrs(list) { return (list ?? []).filter((a) => a?.address).map((a) => (a.name ? { name: a.name, email: a.address } : { email: a.address })); }
function parsedAddrs(v) { return (v?.value ?? []).filter((a) => a.address).map((a) => (a.name ? { name: a.name, email: a.address } : { email: a.address })); }
function rootId(refs, inReplyTo, own) {
    const all = String(refs ?? "").match(/<[^>]+>/g) ?? [];
    return all[0] || String(inReplyTo ?? "").match(/<[^>]+>/)?.[0] || own || "";
}
function hasAttach(struct) {
    if (!struct) return false;
    if (struct.disposition === "attachment" || (struct.dispositionParameters?.filename)) return true;
    return (struct.childNodes ?? []).some(hasAttach);
}
function snippetOf(text) { return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200); }
function bodyOf(p) {
    if (p.text && p.text.trim()) return p.text;
    if (p.html) return convert(p.html, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }] });
    return "";
}

export class IcloudProvider {
    constructor(account, opts = {}) {
        this.account = account;
        this.opts = opts;
        this.client = null;
        this.connecting = null;
        this.queue = Promise.resolve();
        this.boxes = null;
    }
    async secret() {
        if (this.opts.password) return this.opts.password;
        const t = await readToken(this.account.id).catch(() => null);
        if (!t?.password) throw new Error(`"${this.account.nickname}" needs its app-specific password again. Remove it and add it back.`);
        return t.password;
    }
    async imap() {
        if (this.client?.usable) return this.client;
        if (this.connecting) return this.connecting;
        this.connecting = (async () => {
            const c = new ImapFlow({
                host: this.opts.imapHost ?? ICLOUD.imapHost, port: this.opts.imapPort ?? ICLOUD.imapPort,
                secure: this.opts.imapSecure ?? true, auth: { user: this.account.login || this.account.email, pass: await this.secret() },
                logger: false, emitLogs: false, disableAutoIdle: true, socketTimeout: 90_000,
                tls: this.opts.tls,
            });
            c.on("error", () => { });
            c.on("close", () => { if (this.client === c) this.client = null; });
            try { await c.connect(); }
            catch (err) {
                const auth = err?.authenticationFailed || /auth/i.test(String(err?.responseText ?? err?.message ?? ""));
                throw new Error(auth ? `iCloud refused the sign-in for ${this.account.login || this.account.email}. Use your iCloud Mail address (ending in @icloud.com, or the name before the @) and an app-specific password, not your Apple Account password.` : `Couldn't reach iCloud mail: ${err?.message ?? err}`);
            }
            this.client = c;
            return c;
        })().finally(() => { this.connecting = null; });
        return this.connecting;
    }
    /** One mailbox operation at a time on the shared connection. */
    run(fn) {
        const job = this.queue.then(async () => {
            for (let tryNo = 0; ; tryNo++) {
                try { return await fn(await this.imap()); }
                catch (err) {
                    if (tryNo === 0 && (err?.code === "NoConnection" || /closed|ECONNRESET|socket|timeout/i.test(String(err?.message ?? "")))) {
                        try { await this.client?.logout(); } catch { }
                        this.client = null;
                        continue;
                    }
                    throw err;
                }
            }
        });
        this.queue = job.catch(() => { });
        return job;
    }
    async mailboxes() {
        if (this.boxes) return this.boxes;
        this.boxes = await this.run((c) => c.list());
        return this.boxes;
    }
    async special(use, ...names) {
        const list = await this.mailboxes();
        const hit = list.find((b) => b.specialUse === use) ?? list.find((b) => names.some((n) => b.path.toLowerCase() === n.toLowerCase() || b.name?.toLowerCase() === n.toLowerCase()));
        return hit?.path ?? names[0];
    }
    async boxFor(name) {
        const n = String(name ?? "").trim();
        if (!n || /^inbox$/i.test(n)) return "INBOX";
        if (/^sent( items| messages| mail)?$/i.test(n)) return this.special("\\Sent", "Sent Messages", "Sent");
        if (/^drafts?$/i.test(n)) return this.special("\\Drafts", "Drafts");
        if (/^(trash|deleted( items| messages)?|bin)$/i.test(n)) return this.special("\\Trash", "Deleted Messages", "Trash");
        if (/^(archive|all mail)$/i.test(n)) return this.special("\\Archive", "Archive");
        if (/^(junk|spam)$/i.test(n)) return this.special("\\Junk", "Junk");
        const list = await this.mailboxes();
        const hit = list.find((b) => b.path.toLowerCase() === n.toLowerCase() || b.name?.toLowerCase() === n.toLowerCase());
        if (!hit) throw new Error(`There's no folder called "${n}" in this inbox.`);
        return hit.path;
    }
    summary(box, m) {
        const env = m.envelope ?? {};
        const h = m.headers ? m.headers.toString() : "";
        const refs = /^references:\s*([\s\S]*?)(?=\r?\n\S|$)/im.exec(h)?.[1];
        const flags = m.flags ?? new Set();
        return {
            id: icloudId(box, m.uid),
            threadId: rootId(refs, env.inReplyTo, env.messageId) || icloudId(box, m.uid),
            from: addrs(env.from)[0],
            to: addrs(env.to),
            subject: env.subject || "(no subject)",
            date: (m.internalDate ?? env.date ?? new Date()).toISOString?.() ?? String(m.internalDate),
            snippet: m.snippet ?? "",
            unread: !flags.has("\\Seen"),
            starred: flags.has("\\Flagged"),
            labels: [box === "INBOX" ? "INBOX" : box],
            hasAttachments: hasAttach(m.bodyStructure),
        };
    }
    async searchBox(c, box, opts, q) {
        const lock = await c.getMailboxLock(box);
        try {
            const crit = { ...q.crit };
            if (opts.unreadOnly) crit.seen = false;
            // Single-address inboxes: only mail to that address, and in Sent only mail from it.
            if (this.account.onlyAddress) {
                const a = this.account.email;
                if (opts.sentBox) crit.from = a;
                else crit.or = [{ to: a }, { cc: a }, { header: { "delivered-to": a } }, { header: { "x-original-to": a } }];
            }
            if (!Object.keys(crit).length) crit.all = true;
            let uids = (await c.search(crit, { uid: true })) || [];
            uids.sort((a, b) => b - a);
            if (uids.length > MAX_SCAN) uids = uids.slice(0, MAX_SCAN);
            if (!uids.length) return [];
            // Exact dates for the candidates, newest first.
            const dated = [];
            for await (const m of c.fetch(uids, { uid: true, internalDate: true }, { uid: true })) dated.push({ uid: m.uid, t: +m.internalDate });
            const pick = dated
                .filter((d) => (q.afterMs == null || d.t >= q.afterMs) && (q.beforeMs == null || d.t < q.beforeMs))
                .sort((a, b) => b.t - a.t)
                .slice(0, opts.maxResults ?? 20)
                .map((d) => d.uid);
            if (!pick.length) return [];
            const out = [];
            for await (const m of c.fetch(pick, {
                uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true,
                headers: ["references"], source: { start: 0, maxLength: 12_000 },
            }, { uid: true })) {
                let snippet = "";
                try { const p = await simpleParser(m.source, { skipImageLinks: true, skipTextToHtml: true }); snippet = snippetOf(bodyOf(p)); } catch { }
                out.push(this.summary(box, { ...m, snippet }));
            }
            return out;
        }
        finally { lock.release(); }
    }
    async search(opts) {
        const q = parseQuery(opts.query);
        let boxes;
        if (opts.folder) boxes = [await this.boxFor(opts.folder)];
        else if (opts.query) boxes = [...new Set(["INBOX", await this.boxFor("Archive").catch(() => null), await this.boxFor("Sent").catch(() => null)].filter(Boolean))];
        else boxes = ["INBOX"];
        const all = [];
        const sentPath = await this.boxFor("Sent").catch(() => null);
        for (const box of boxes) {
            try { all.push(...(await this.run((c) => this.searchBox(c, box, { ...opts, sentBox: box === sentPath }, q)))); }
            catch (err) { if (boxes.length === 1) throw err; }
        }
        return all.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, opts.maxResults ?? 20);
    }
    async fetchFull(id) {
        const { box, uid } = splitId(id);
        return this.run(async (c) => {
            const lock = await c.getMailboxLock(box);
            try {
                const m = await c.fetchOne(String(uid), { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true, source: true, headers: ["references"] }, { uid: true });
                if (!m) throw new Error("That email isn't in this inbox any more.");
                return { box, m, parsed: await simpleParser(m.source) };
            }
            finally { lock.release(); }
        });
    }
    toEmail(box, m, p) {
        const sum = this.summary(box, { ...m, snippet: snippetOf(bodyOf(p)) });
        const attachments = (p.attachments ?? []).filter((a) => a.contentDisposition === "attachment" || a.filename)
            .map((a, i) => ({ id: String(i), filename: a.filename || `attachment-${i + 1}`, mimeType: a.contentType, size: a.size }));
        return {
            ...sum,
            hasAttachments: attachments.length > 0,
            cc: parsedAddrs(p.cc),
            replyTo: parsedAddrs(p.replyTo),
            ...truncateBody(bodyOf(p)),
            attachments,
        };
    }
    async getEmail(id) {
        const { box, m, parsed } = await this.fetchFull(id);
        return this.toEmail(box, m, parsed);
    }
    async getThread(threadId) {
        const root = String(threadId ?? "");
        if (!root.startsWith("<")) return [await this.getEmail(root)];
        const boxes = [...new Set(["INBOX", await this.boxFor("Sent").catch(() => null), await this.boxFor("Archive").catch(() => null)].filter(Boolean))];
        const ids = [];
        for (const box of boxes) {
            const found = await this.run(async (c) => {
                const lock = await c.getMailboxLock(box);
                try {
                    const a = (await c.search({ header: { "message-id": root } }, { uid: true })) || [];
                    const b = (await c.search({ header: { references: root } }, { uid: true })) || [];
                    return [...new Set([...a, ...b])].slice(-30);
                }
                finally { lock.release(); }
            }).catch(() => []);
            for (const uid of found) ids.push(icloudId(box, uid));
        }
        const out = [];
        for (const id of ids) out.push(await this.getEmail(id).catch(() => null));
        const a = this.account.onlyAddress ? this.account.email.toLowerCase() : null;
        const keep = (e) => !a || [e.from, ...(e.to ?? []), ...(e.cc ?? [])].some((x) => x?.email?.toLowerCase() === a);
        return out.filter(Boolean).filter(keep).sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
    }
    async listFolders() {
        this.boxes = null;
        const list = await this.mailboxes();
        const out = [];
        for (const b of list) {
            if (b.flags?.has?.("\\Noselect")) continue;
            let st = null;
            try { st = await this.run((c) => c.status(b.path, { messages: true, unseen: true })); } catch { }
            out.push({ id: b.path, name: b.path === "INBOX" ? "Inbox" : b.name, kind: b.specialUse ? "system" : "user", unread: st?.unseen, total: st?.messages });
        }
        return out;
    }
    /** Which of this inbox's addresses a message to `recips` should come from. */
    pickFrom(explicit, recips) {
        if (this.account.onlyAddress) {
            const e = explicit ? (String(explicit).match(/<([^>]+)>/)?.[1] ?? String(explicit).trim()) : "";
            if (e && e.toLowerCase() !== this.account.email.toLowerCase()) throw new Error(`This inbox only sends from ${this.account.email}.`);
            return this.account.email;
        }
        const mine = [this.account.email, ...(this.account.aliases ?? [])].map((a) => a.toLowerCase());
        if (explicit) {
            const e = String(explicit).match(/<([^>]+)>/)?.[1] ?? String(explicit).trim();
            if (!mine.includes(e.toLowerCase())) throw new Error(`${e} isn't one of this inbox's addresses (${mine.join(", ")}).`);
            return e;
        }
        const hit = (recips ?? []).map((a) => String(a.email ?? a).toLowerCase()).find((a) => mine.includes(a));
        return hit || this.account.sendAs || this.account.email;
    }
    async compose(msg) {
        let to = msg.to ?? [], cc = msg.cc ?? [], subject = msg.subject, inReplyTo, references, replyRecips = [];
        if (msg.replyToId) {
            const { parsed } = await this.fetchFull(msg.replyToId);
            const origTo = parsedAddrs(parsed.to), origCc = parsedAddrs(parsed.cc);
            replyRecips = [...origTo, ...origCc];
            inReplyTo = parsed.messageId;
            const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
            references = [...refs, parsed.messageId].filter(Boolean).join(" ") || undefined;
            subject ??= /^re:/i.test(parsed.subject ?? "") ? parsed.subject : `Re: ${parsed.subject ?? ""}`;
            if (!to.length) {
                const mine = new Set([this.account.email, this.account.login, ...(this.account.aliases ?? [])].filter(Boolean).map((a) => a.toLowerCase()));
                const sender = parsedAddrs(parsed.replyTo).length ? parsedAddrs(parsed.replyTo) : parsedAddrs(parsed.from);
                to = sender.map((a) => fmtAddr({ name: a.name, address: a.email }));
                if (msg.replyAll) {
                    const others = replyRecips.filter((a) => !mine.has(a.email.toLowerCase())).map((a) => fmtAddr({ name: a.name, address: a.email })).filter((a) => !to.includes(a));
                    cc = [...cc, ...others];
                }
            }
        }
        if (!to.length) throw new Error("Add at least one recipient.");
        const attachments = [...(msg.attachments ?? [])];
        if (msg.includeAttachmentsFrom) {
            const { parsed } = await this.fetchFull(msg.includeAttachmentsFrom);
            for (const a of parsed.attachments ?? []) attachments.push({ filename: a.filename || "attachment", mimeType: a.contentType, data: a.content });
        }
        const total = attachments.reduce((n, a) => n + (a.data?.length ?? 0), 0);
        if (total > 18 * 1024 * 1024) throw new Error("Those attachments are over 18 MB together. iCloud won't send that much in one email.");
        const from = this.pickFrom(msg.from, replyRecips);
        const fromName = this.account.senderName;
        const mail = {
            from: fromName ? { name: fromName, address: from } : from,
            to, cc: cc.length ? cc : undefined, bcc: msg.bcc?.length ? msg.bcc : undefined,
            subject: subject ?? "", text: msg.body, inReplyTo, references,
            attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.mimeType, content: a.data })),
        };
        const raw = await new Promise((res, rej) => {
            nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" })
                .sendMail(mail, (err, info) => (err ? rej(err) : res(info.message)));
        });
        return { mail, raw, from };
    }
    smtp(pass) {
        // iCloud signs in with the iCloud Mail address; an alias or custom-domain address goes in From.
        const login = this.account.login || this.account.email;
        return nodemailer.createTransport({
            host: this.opts.smtpHost ?? ICLOUD.smtpHost, port: this.opts.smtpPort ?? ICLOUD.smtpPort,
            secure: this.opts.smtpSecure ?? false, requireTLS: this.opts.smtpRequireTLS ?? true,
            tls: this.opts.tls, auth: { user: login.includes("@") ? login : `${login}@icloud.com`, pass },
            connectionTimeout: 30_000, socketTimeout: 60_000,
        });
    }
    /** The raw headers of one email (lowercase names), for List-Unsubscribe. */
    async headers(id) {
        const { parsed } = await this.fetchFull(id);
        const h = {};
        for (const line of parsed.headerLines ?? []) h[line.key] ??= String(line.line).replace(/^[^:]*:\s*/, "").replace(/\r?\n\s+/g, " ");
        return h;
    }
    async sendRaw(raw, from, envelopeTo) {
        const t = this.smtp(await this.secret());
        await t.sendMail({ envelope: { from, to: envelopeTo }, raw });
        // iCloud doesn't keep a copy of mail sent over SMTP, so file it in Sent Messages.
        const sent = await this.boxFor("Sent").catch(() => "Sent Messages");
        await this.run((c) => c.append(sent, raw, ["\\Seen"])).catch(() => { });
    }
    async send(msg) {
        const { mail, raw, from } = await this.compose(msg);
        const rcpt = [mail.to, mail.cc, mail.bcc].flat().filter(Boolean).flatMap((x) => parseAddressList(String(x)).map((a) => a.email));
        await this.sendRaw(raw, from, rcpt);
    }
    async createDraft(msg) {
        const { mail, raw } = await this.compose(msg);
        const box = await this.boxFor("Drafts");
        const res = await this.run((c) => c.append(box, raw, ["\\Draft", "\\Seen"]));
        let uid = res?.uid;
        if (!uid) {
            const mid = String(raw).match(/^Message-ID:\s*(<[^>]+>)/im)?.[1];
            uid = await this.run(async (c) => {
                const lock = await c.getMailboxLock(box);
                try { const u = mid ? await c.search({ header: { "message-id": mid } }, { uid: true }) : []; return (u || []).pop(); }
                finally { lock.release(); }
            });
        }
        if (!uid) throw new Error("The draft was saved but iCloud didn't say where. Look in the Drafts folder.");
        return { id: icloudId(box, uid), messageId: icloudId(box, uid), subject: mail.subject, to: [mail.to].flat().flatMap((x) => parseAddressList(String(x))) };
    }
    async sendDraft(draftId) {
        const { box, m, parsed } = await this.fetchFull(draftId);
        const rcpt = [...parsedAddrs(parsed.to), ...parsedAddrs(parsed.cc), ...parsedAddrs(parsed.bcc)].map((a) => a.email);
        if (!rcpt.length) throw new Error("That draft has no recipients.");
        const from = parsedAddrs(parsed.from)[0]?.email ?? this.account.email;
        this.pickFrom(from);
        await this.sendRaw(m.source, from, rcpt);
        await this.run(async (c) => {
            const lock = await c.getMailboxLock(box);
            try { await c.messageDelete(String(m.uid), { uid: true }); } finally { lock.release(); }
        }).catch(() => { });
    }
    async getAttachment(emailId, want) {
        const { parsed } = await this.fetchFull(emailId);
        const list = parsed.attachments ?? [];
        const a = (want.id != null ? list[Number(want.id)] : undefined) ??
            (want.filename ? list.find((x) => x.filename === want.filename) : undefined) ??
            (list.length === 1 ? list[0] : undefined);
        if (!a) throw new Error("That email has no attachment with that name.");
        return { filename: a.filename || "attachment", mimeType: a.contentType || "application/octet-stream", data: a.content };
    }
    async allAttachments(emailId) {
        const { parsed } = await this.fetchFull(emailId);
        return (parsed.attachments ?? []).map((a) => ({ filename: a.filename || "attachment", mimeType: a.contentType, data: a.content }));
    }
    async update(id, changes) {
        const { box, uid } = splitId(id);
        let dest = null;
        if (changes.trash) dest = await this.boxFor("Trash");
        else if (changes.archive) dest = await this.boxFor("Archive");
        else if (changes.moveTo) dest = await this.boxFor(changes.moveTo);
        return this.run(async (c) => {
            const lock = await c.getMailboxLock(box);
            try {
                const u = String(uid), o = { uid: true };
                if (changes.read === true) await c.messageFlagsAdd(u, ["\\Seen"], o);
                if (changes.read === false) await c.messageFlagsRemove(u, ["\\Seen"], o);
                if (changes.starred === true) await c.messageFlagsAdd(u, ["\\Flagged"], o);
                if (changes.starred === false) await c.messageFlagsRemove(u, ["\\Flagged"], o);
                if (dest && dest !== box) {
                    const r = await c.messageMove(u, dest, o);
                    const nu = r?.uidMap?.get?.(uid);
                    return { id: nu ? icloudId(dest, nu) : id };
                }
                return { id };
            }
            finally { lock.release(); }
        });
    }
}

/** Checks an address and app-specific password by signing in to IMAP and SMTP. */
export async function verifyIcloud(email, password, opts = {}, login) {
    const p = new IcloudProvider({ id: "check", nickname: email, email, login }, { ...opts, password });
    try { await p.run((c) => c.list()); }
    finally { try { await p.client?.logout(); } catch { } }
    const t = p.smtp(password);
    try { await t.verify(); }
    catch (err) { throw new Error(`iCloud accepted the password for reading mail but not for sending (${err?.message ?? err}).`); }
}
