import { convert as htmlToText } from "html-to-text";
import { base64url, buildMime, checkAttachmentSize, replySubject } from "../mime.js";
import { parseAddressList, truncateBody, } from "./types.js";
const API = (process.env.EMAIL_MCP_GMAIL_API ?? "https://gmail.googleapis.com") + "/gmail/v1/users/me";
/** Friendly names people use for Gmail's built-in labels. */
const SYSTEM_LABELS = {
    inbox: "INBOX",
    sent: "SENT",
    "sent items": "SENT",
    drafts: "DRAFT",
    draft: "DRAFT",
    spam: "SPAM",
    junk: "SPAM",
    trash: "TRASH",
    deleted: "TRASH",
    "deleted items": "TRASH",
    starred: "STARRED",
    important: "IMPORTANT",
    unread: "UNREAD",
};
const SUMMARY_HEADERS = ["From", "To", "Subject", "Date"];
/** Google turns away an account with too many requests in flight ("Too many concurrent requests for user"),
 *  so each inbox keeps at most this many open at once and retries busy answers after a growing wait. */
const GMAIL_CONCURRENCY = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isBusy(err) {
    const status = err?.response?.status ?? err?.status;
    const reasons = JSON.stringify(err?.response?.data?.error?.errors ?? "");
    return (status === 429 ||
        status === 503 ||
        (status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reasons)) ||
        /concurrent requests|rate limit/i.test(String(err?.message ?? "")));
}
export class GmailProvider {
    client;
    labels;
    labelsP;
    ownAddress;
    active = 0;
    waiting = [];
    constructor(client) {
        this.client = client;
    }
    acquire() {
        if (this.active < GMAIL_CONCURRENCY) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve) => this.waiting.push(resolve));
    }
    release() {
        const next = this.waiting.shift();
        if (next)
            next();
        else
            this.active--;
    }
    async call(path, opts = {}) {
        for (let attempt = 0;; attempt++) {
            await this.acquire();
            let busy = false;
            try {
                const res = await this.client.request({
                    url: API + path,
                    method: (opts.method ?? "GET"),
                    params: opts.params,
                    data: opts.data,
                    paramsSerializer: serializeParams,
                });
                return res.data;
            }
            catch (err) {
                if (attempt >= 5 || !isBusy(err))
                    throw err;
                busy = true;
            }
            finally {
                this.release();
            }
            if (busy)
                await sleep(1000 * 2 ** attempt + Math.random() * 400);
        }
    }
    async allLabels(refresh = false) {
        // One shared lookup: a search summarizes many emails at once and each needs label names.
        if (!this.labelsP || refresh) {
            this.labelsP = this.call("/labels").then((res) => (this.labels = res.labels ?? []), (err) => {
                this.labelsP = undefined;
                throw err;
            });
        }
        return this.labelsP;
    }
    async labelName(id) {
        const label = (await this.allLabels()).find((l) => l.id === id);
        return label?.name ?? id;
    }
    /** Resolves a folder/label name to its id. With create, makes a new label if none exists. */
    async labelId(name, create = false) {
        const system = SYSTEM_LABELS[name.trim().toLowerCase()];
        if (system)
            return system;
        const labels = await this.allLabels();
        const match = labels.find((l) => l.id === name) ??
            labels.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
        if (match)
            return match.id;
        if (!create)
            throw new Error(`There's no label called "${name}" in this inbox.`);
        const made = await this.call("/labels", {
            method: "POST",
            data: { name: name.trim(), labelListVisibility: "labelShow", messageListVisibility: "show" },
        });
        await this.allLabels(true);
        return made.id;
    }
    async me() {
        if (!this.ownAddress) {
            const profile = await this.call("/profile");
            this.ownAddress = profile.emailAddress;
        }
        return this.ownAddress;
    }
    async toSummary(msg) {
        const h = headerMap(msg.payload?.headers);
        const labelIds = msg.labelIds ?? [];
        const labels = [];
        for (const id of labelIds) {
            if (id === "UNREAD" || id === "STARRED" || id.startsWith("CATEGORY_"))
                continue;
            labels.push(await this.labelName(id));
        }
        return {
            id: msg.id,
            threadId: msg.threadId,
            from: parseAddressList(h.from)[0],
            to: parseAddressList(h.to),
            subject: h.subject ?? "(no subject)",
            date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : (h.date ?? ""),
            snippet: decodeEntities(msg.snippet ?? ""),
            unread: labelIds.includes("UNREAD"),
            starred: labelIds.includes("STARRED"),
            labels,
            hasAttachments: collectAttachments(msg.payload).length > 0 || hasMixedPart(msg.payload),
        };
    }
    async toEmail(msg) {
        const summary = await this.toSummary(msg);
        const h = headerMap(msg.payload?.headers);
        const attachments = collectAttachments(msg.payload);
        return {
            ...summary,
            hasAttachments: attachments.length > 0,
            cc: parseAddressList(h.cc),
            replyTo: parseAddressList(h["reply-to"]),
            ...truncateBody(extractBody(msg.payload)),
            attachments,
        };
    }
    async search(opts) {
        const labelIds = [];
        if (opts.folder)
            labelIds.push(await this.labelId(opts.folder));
        if (opts.unreadOnly)
            labelIds.push("UNREAD");
        const list = await this.call("/messages", {
            params: { q: opts.query || undefined, labelIds, maxResults: opts.maxResults },
        });
        const ids = (list.messages ?? []).map((m) => m.id);
        const messages = await Promise.all(ids.map((id) => this.call(`/messages/${id}`, {
            params: { format: "metadata", metadataHeaders: SUMMARY_HEADERS },
        })));
        return Promise.all(messages.map((m) => this.toSummary(m)));
    }
    async getEmail(id) {
        const msg = await this.call(`/messages/${enc(id)}`, {
            params: { format: "full" },
        });
        return this.toEmail(msg);
    }
    async getThread(threadId) {
        const thread = await this.call(`/threads/${enc(threadId)}`, {
            params: { format: "full" },
        });
        return Promise.all((thread.messages ?? []).map((m) => this.toEmail(m)));
    }
    async listFolders() {
        const labels = await this.allLabels(true);
        const detailed = await Promise.all(labels.map((l) => this.call(`/labels/${enc(l.id)}`).catch(() => l)));
        return detailed
            .filter((l) => !l.id.startsWith("CATEGORY_") && l.id !== "UNREAD" && l.id !== "CHAT")
            .map((l) => ({
            id: l.id,
            name: l.name,
            kind: l.type,
            unread: l.messagesUnread,
            total: l.messagesTotal,
        }));
    }
    /** Builds the raw message, filling in reply headers and recipients when replying. */
    async compose(msg) {
        let to = msg.to;
        let cc = msg.cc ?? [];
        let subject = msg.subject;
        let inReplyTo;
        let references;
        let threadId;
        if (msg.replyToId) {
            const orig = await this.call(`/messages/${enc(msg.replyToId)}`, {
                params: {
                    format: "metadata",
                    metadataHeaders: ["From", "To", "Cc", "Reply-To", "Subject", "Message-ID", "References"],
                },
            });
            const h = headerMap(orig.payload?.headers);
            threadId = orig.threadId;
            inReplyTo = h["message-id"];
            references = [h.references, h["message-id"]].filter(Boolean).join(" ") || undefined;
            subject ??= replySubject(h.subject ?? "");
            if (!to.length) {
                const me = (await this.me()).toLowerCase();
                const sender = parseAddressList(h["reply-to"] || h.from).map(formatAddress);
                to = sender;
                if (msg.replyAll) {
                    const others = [...parseAddressList(h.to), ...parseAddressList(h.cc)]
                        .filter((a) => a.email.toLowerCase() !== me)
                        .map(formatAddress)
                        .filter((a) => !to.includes(a));
                    cc = [...cc, ...others];
                }
            }
        }
        if (!to.length)
            throw new Error("Add at least one recipient.");
        const attachments = [...(msg.attachments ?? [])];
        if (msg.includeAttachmentsFrom)
            attachments.push(...(await this.allAttachments(msg.includeAttachmentsFrom)));
        checkAttachmentSize(attachments);
        const raw = buildMime({
            to,
            cc,
            bcc: msg.bcc,
            subject: subject ?? "",
            body: msg.body,
            inReplyTo,
            references,
            attachments,
        });
        return { raw: base64url(raw), threadId };
    }
    /** One attachment's file. Gmail issues new attachment ids on every read, so a filename also finds it. */
    async getAttachment(emailId, want) {
        const msg = await this.call(`/messages/${enc(emailId)}`, { params: { format: "full" } });
        const all = collectAttachments(msg.payload);
        const meta = all.find((a) => a.id === want.id) ??
            (want.filename ? all.find((a) => a.filename === want.filename) : undefined) ??
            (all.length === 1 ? all[0] : undefined);
        const id = meta?.id ?? want.id;
        if (!id)
            throw new Error("That email has no attachment with that name.");
        const res = await this.call(`/messages/${enc(emailId)}/attachments/${enc(id)}`);
        return {
            filename: meta?.filename ?? want.filename ?? "attachment",
            mimeType: meta?.mimeType ?? "application/octet-stream",
            data: Buffer.from(res.data ?? "", "base64url"),
        };
    }
    /** Every attachment on an email, for carrying them onto a forward. */
    async allAttachments(emailId) {
        const msg = await this.call(`/messages/${enc(emailId)}`, { params: { format: "full" } });
        const out = [];
        for (const a of collectAttachments(msg.payload)) {
            const res = await this.call(`/messages/${enc(emailId)}/attachments/${enc(a.id)}`);
            out.push({ filename: a.filename, mimeType: a.mimeType, data: Buffer.from(res.data ?? "", "base64url") });
        }
        return out;
    }
    async createDraft(msg) {
        const message = await this.compose(msg);
        const draft = await this.call("/drafts", {
            method: "POST",
            data: { message },
        });
        const full = await this.call(`/messages/${draft.message.id}`, {
            params: { format: "metadata", metadataHeaders: ["To", "Subject"] },
        });
        const h = headerMap(full.payload?.headers);
        return {
            id: draft.id,
            messageId: draft.message.id,
            subject: h.subject ?? "",
            to: parseAddressList(h.to),
        };
    }
    async sendDraft(draftId) {
        await this.call("/drafts/send", { method: "POST", data: { id: draftId } });
    }
    async send(msg) {
        const message = await this.compose(msg);
        await this.call("/messages/send", { method: "POST", data: message });
    }
    async update(id, changes) {
        const add = new Set();
        const remove = new Set();
        if (changes.read === true)
            remove.add("UNREAD");
        if (changes.read === false)
            add.add("UNREAD");
        if (changes.starred === true)
            add.add("STARRED");
        if (changes.starred === false)
            remove.add("STARRED");
        if (changes.archive)
            remove.add("INBOX");
        if (changes.moveTo) {
            const target = await this.labelId(changes.moveTo, true);
            add.add(target);
            if (target !== "INBOX")
                remove.add("INBOX");
        }
        for (const name of changes.addLabels ?? [])
            add.add(await this.labelId(name, true));
        for (const name of changes.removeLabels ?? [])
            remove.add(await this.labelId(name));
        if (add.size || remove.size) {
            await this.call(`/messages/${enc(id)}/modify`, {
                method: "POST",
                data: { addLabelIds: [...add], removeLabelIds: [...remove] },
            });
        }
        if (changes.trash)
            await this.call(`/messages/${enc(id)}/trash`, { method: "POST" });
        return { id };
    }
}
function enc(id) {
    return encodeURIComponent(id);
}
/** Gmail wants repeated keys for arrays (labelIds=A&labelIds=B). */
function serializeParams(params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null)
            continue;
        if (Array.isArray(v))
            for (const item of v)
                sp.append(k, String(item));
        else
            sp.append(k, String(v));
    }
    return sp.toString();
}
function headerMap(headers) {
    const out = {};
    for (const h of headers ?? [])
        out[h.name.toLowerCase()] ??= h.value;
    return out;
}
function formatAddress(a) {
    return a.name ? `"${a.name.replace(/"/g, "")}" <${a.email}>` : a.email;
}
function decode(data) {
    return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}
function decodeEntities(s) {
    return s
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;|&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}
function extractBody(part) {
    let plain;
    let html;
    const walk = (p) => {
        if (!p)
            return;
        if (p.filename)
            return; // attachments
        if (p.mimeType === "text/plain" && plain === undefined)
            plain = decode(p.body?.data);
        else if (p.mimeType === "text/html" && html === undefined)
            html = decode(p.body?.data);
        p.parts?.forEach(walk);
    };
    walk(part);
    if (plain?.trim())
        return plain.trim();
    if (html)
        return htmlToText(html, {
            wordwrap: false,
            selectors: [{ selector: "img", format: "skip" }],
        }).trim();
    return "";
}
function collectAttachments(part) {
    const out = [];
    const walk = (p) => {
        if (!p)
            return;
        if (p.filename && p.body?.attachmentId) {
            out.push({
                id: p.body.attachmentId,
                filename: p.filename,
                mimeType: p.mimeType ?? "application/octet-stream",
                size: p.body.size ?? 0,
            });
        }
        p.parts?.forEach(walk);
    };
    walk(part);
    return out;
}
/** In metadata format Gmail omits parts, so a multipart/mixed top level is our attachment hint. */
function hasMixedPart(part) {
    return part?.mimeType === "multipart/mixed";
}
//# sourceMappingURL=gmail.js.map