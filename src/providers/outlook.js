import { truncateBody, } from "./types.js";
import { checkAttachmentSize } from "../mime.js";
/** Graph takes attachments up to 3 MB in one request; bigger ones go through an upload session in chunks. */
const SMALL_ATTACHMENT = 3 * 1024 * 1024;
const UPLOAD_CHUNK = 10 * 320 * 1024;
const API = (process.env.EMAIL_MCP_GRAPH_API ?? "https://graph.microsoft.com") + "/v1.0/me";
const SUMMARY_FIELDS = [
    "id",
    "conversationId",
    "subject",
    "from",
    "toRecipients",
    "receivedDateTime",
    "bodyPreview",
    "isRead",
    "hasAttachments",
    "categories",
    "flag",
    "parentFolderId",
].join(",");
const FULL_FIELDS = SUMMARY_FIELDS + ",ccRecipients,replyTo,body";
/** Friendly names mapped to Graph's well-known folder names. */
const WELL_KNOWN = {
    inbox: "inbox",
    sent: "sentitems",
    "sent items": "sentitems",
    drafts: "drafts",
    draft: "drafts",
    archive: "archive",
    trash: "deleteditems",
    deleted: "deleteditems",
    "deleted items": "deleteditems",
    junk: "junkemail",
    spam: "junkemail",
    "junk email": "junkemail",
    outbox: "outbox",
};
export class GraphError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
/** One call to Graph under /me, with readable errors. Bodies come back as plain text. */
export async function graphRequest(getToken, path, opts = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(opts.params ?? {}))
        url.searchParams.set(k, String(v));
    const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
            Authorization: `Bearer ${await getToken()}`,
            "Content-Type": "application/json",
            Prefer: ['outlook.body-content-type="text"', ...(opts.prefer ?? [])].join(", "),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (!res.ok) {
        let detail = res.statusText;
        try {
            const err = (await res.json());
            detail = err.error?.message ?? detail;
        }
        catch {
            // not JSON
        }
        throw new GraphError(res.status, `Microsoft returned an error (${res.status}): ${detail}`);
    }
    if (res.status === 202 || res.status === 204)
        return undefined;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined);
}
export class OutlookProvider {
    getToken;
    folderNames;
    constructor(getToken) {
        this.getToken = getToken;
    }
    call(path, opts = {}) {
        return graphRequest(this.getToken, path, opts);
    }
    async allFolders() {
        const top = await this.call("/mailFolders", {
            params: { $top: 200 },
        });
        const folders = [...top.value];
        // One level of subfolders covers most setups without many calls.
        const parents = top.value.filter((f) => (f.childFolderCount ?? 0) > 0);
        const children = await Promise.all(parents.map((p) => this.call(`/mailFolders/${enc(p.id)}/childFolders`, {
            params: { $top: 200 },
        }).then((r) => r.value.map((c) => ({ ...c, displayName: `${p.displayName}/${c.displayName}` })))));
        folders.push(...children.flat());
        this.folderNames = new Map(folders.map((f) => [f.id, f.displayName]));
        return folders;
    }
    async folderId(name) {
        const known = WELL_KNOWN[name.trim().toLowerCase()];
        if (known)
            return known;
        const folders = await this.allFolders();
        const lower = name.trim().toLowerCase();
        const match = folders.find((f) => f.id === name) ??
            folders.find((f) => f.displayName.toLowerCase() === lower) ??
            folders.find((f) => f.displayName.toLowerCase().endsWith("/" + lower));
        if (!match)
            throw new Error(`There's no folder called "${name}" in this inbox.`);
        return match.id;
    }
    async folderName(id) {
        if (!id)
            return undefined;
        if (!this.folderNames)
            await this.allFolders().catch(() => undefined);
        return this.folderNames?.get(id);
    }
    async toSummary(m) {
        const folder = await this.folderName(m.parentFolderId);
        return {
            id: m.id,
            threadId: m.conversationId,
            from: m.from ? addr(m.from) : undefined,
            to: (m.toRecipients ?? []).map(addr),
            subject: m.subject || "(no subject)",
            date: m.receivedDateTime ?? "",
            snippet: m.bodyPreview ?? "",
            unread: m.isRead === false,
            starred: m.flag?.flagStatus === "flagged",
            labels: [...(folder ? [folder] : []), ...(m.categories ?? [])],
            hasAttachments: !!m.hasAttachments,
        };
    }
    async toEmail(m) {
        const summary = await this.toSummary(m);
        const attachments = m.hasAttachments
            ? (await this.call(`/messages/${enc(m.id)}/attachments`, {
                params: { $select: "id,name,contentType,size,isInline" },
            })).value
                .filter((a) => !a.isInline)
                .map((a) => ({ id: a.id, filename: a.name, mimeType: a.contentType, size: a.size }))
            : [];
        return {
            ...summary,
            cc: (m.ccRecipients ?? []).map(addr),
            replyTo: (m.replyTo ?? []).map(addr),
            ...truncateBody((m.body?.content ?? "").trim()),
            attachments,
        };
    }
    async search(opts) {
        const base = opts.folder
            ? `/mailFolders/${enc(await this.folderId(opts.folder))}/messages`
            : "/messages";
        let messages;
        if (opts.query) {
            // $search can't be combined with $filter or $orderby, so unread is filtered here.
            const res = await this.call(base, {
                params: {
                    $search: `"${opts.query.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
                    $select: SUMMARY_FIELDS,
                    $top: opts.unreadOnly ? Math.min(opts.maxResults * 4, 250) : opts.maxResults,
                },
            });
            messages = res.value;
            if (opts.unreadOnly)
                messages = messages.filter((m) => m.isRead === false);
            messages = messages.slice(0, opts.maxResults);
        }
        else {
            // Graph needs the $orderby property to appear first in $filter.
            const filter = ["receivedDateTime ge 1900-01-01T00:00:00Z"];
            if (opts.unreadOnly)
                filter.push("isRead eq false");
            const res = await this.call(base, {
                params: {
                    $filter: filter.join(" and "),
                    $orderby: "receivedDateTime desc",
                    $select: SUMMARY_FIELDS,
                    $top: opts.maxResults,
                },
            });
            messages = res.value;
        }
        return Promise.all(messages.map((m) => this.toSummary(m)));
    }
    async getEmail(id) {
        const m = await this.call(`/messages/${enc(id)}`, {
            params: { $select: FULL_FIELDS },
        });
        return this.toEmail(m);
    }
    async getThread(threadId) {
        const res = await this.call("/messages", {
            params: {
                $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`,
                $select: FULL_FIELDS,
                $top: 50,
            },
        });
        const sorted = res.value.sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
        return Promise.all(sorted.map((m) => this.toEmail(m)));
    }
    async listFolders() {
        const folders = await this.allFolders();
        const wellKnown = new Set(await Promise.all(["inbox", "sentitems", "drafts", "archive", "deleteditems", "junkemail", "outbox"].map((n) => this.call(`/mailFolders/${n}`, { params: { $select: "id" } })
            .then((f) => f.id)
            .catch(() => ""))));
        return folders.map((f) => ({
            id: f.id,
            name: f.displayName,
            kind: wellKnown.has(f.id) ? "system" : "user",
            unread: f.unreadItemCount,
            total: f.totalItemCount,
        }));
    }
    async createDraft(msg) {
        let draft;
        if (msg.replyToId) {
            const action = msg.replyAll ? "createReplyAll" : "createReply";
            draft = await this.call(`/messages/${enc(msg.replyToId)}/${action}`, {
                method: "POST",
                body: { comment: msg.body, message: replyOverrides(msg) },
            });
        }
        else {
            if (!msg.to.length)
                throw new Error("Add at least one recipient.");
            draft = await this.call("/messages", { method: "POST", body: newMessage(msg) });
        }
        const files = await this.outgoingFiles(msg);
        if (files.length) {
            try {
                await this.addAttachments(draft.id, files);
            }
            catch (err) {
                // Don't leave a half-built draft behind.
                await this.call(`/messages/${enc(draft.id)}`, { method: "DELETE" }).catch(() => undefined);
                throw err;
            }
        }
        return {
            id: draft.id,
            messageId: draft.id,
            subject: draft.subject ?? "",
            to: (draft.toRecipients ?? []).map(addr),
        };
    }
    async outgoingFiles(msg) {
        const files = [...(msg.attachments ?? [])];
        if (msg.includeAttachmentsFrom)
            files.push(...(await this.allAttachments(msg.includeAttachmentsFrom)));
        checkAttachmentSize(files);
        return files;
    }
    async addAttachments(messageId, files) {
        for (const f of files) {
            const contentType = f.mimeType || "application/octet-stream";
            if (f.data.length <= SMALL_ATTACHMENT) {
                await this.call(`/messages/${enc(messageId)}/attachments`, {
                    method: "POST",
                    body: { "@odata.type": "#microsoft.graph.fileAttachment", name: f.filename, contentType, contentBytes: f.data.toString("base64") },
                });
                continue;
            }
            const session = await this.call(`/messages/${enc(messageId)}/attachments/createUploadSession`, {
                method: "POST",
                body: { AttachmentItem: { attachmentType: "file", name: f.filename, size: f.data.length, contentType } },
            });
            for (let start = 0; start < f.data.length; start += UPLOAD_CHUNK) {
                const chunk = f.data.subarray(start, Math.min(start + UPLOAD_CHUNK, f.data.length));
                // The upload URL carries its own authorization; Graph rejects an Authorization header here.
                const res = await fetch(session.uploadUrl, {
                    method: "PUT",
                    headers: {
                        "Content-Length": String(chunk.length),
                        "Content-Range": `bytes ${start}-${start + chunk.length - 1}/${f.data.length}`,
                    },
                    body: chunk,
                });
                if (!res.ok)
                    throw new GraphError(res.status, `Microsoft didn't accept "${f.filename}" (${res.status}).`);
            }
        }
    }
    /** One attachment's file, found by id or by filename. */
    async getAttachment(emailId, want) {
        let id = want.id;
        if (!id) {
            const list = await this.call(`/messages/${enc(emailId)}/attachments`, {
                params: { $select: "id,name" },
            });
            id = list.value.find((a) => a.name === want.filename)?.id;
            if (!id)
                throw new Error("That email has no attachment with that name.");
        }
        const a = await this.call(`/messages/${enc(emailId)}/attachments/${enc(id)}`);
        if (!a.contentBytes)
            throw new Error(`"${a.name}" is an attached email or a cloud link, which can't be downloaded here. Open it in Outlook.`);
        return { filename: a.name, mimeType: a.contentType || "application/octet-stream", data: Buffer.from(a.contentBytes, "base64") };
    }
    /** Every file attachment on an email, for carrying them onto a forward. */
    async allAttachments(emailId) {
        const list = await this.call(`/messages/${enc(emailId)}/attachments`, {
            params: { $select: "id,name,isInline" },
        });
        const out = [];
        for (const a of list.value.filter((x) => !x.isInline)) {
            const full = await this.call(`/messages/${enc(emailId)}/attachments/${enc(a.id)}`);
            if (full.contentBytes)
                out.push({ filename: full.name, mimeType: full.contentType || "application/octet-stream", data: Buffer.from(full.contentBytes, "base64") });
        }
        return out;
    }
    async sendDraft(draftId) {
        await this.call(`/messages/${enc(draftId)}/send`, { method: "POST" });
    }
    async send(msg) {
        if (msg.attachments?.length || msg.includeAttachmentsFrom) {
            // Attachments have to be added to a draft first, then the draft is sent.
            const draft = await this.createDraft(msg);
            await this.sendDraft(draft.id);
            return;
        }
        if (msg.replyToId) {
            const action = msg.replyAll ? "replyAll" : "reply";
            await this.call(`/messages/${enc(msg.replyToId)}/${action}`, {
                method: "POST",
                body: { comment: msg.body, message: replyOverrides(msg) },
            });
            return;
        }
        if (!msg.to.length)
            throw new Error("Add at least one recipient.");
        await this.call("/sendMail", {
            method: "POST",
            body: { message: newMessage(msg), saveToSentItems: true },
        });
    }
    async update(id, changes) {
        const patch = {};
        if (changes.read !== undefined)
            patch.isRead = changes.read;
        if (changes.starred !== undefined) {
            patch.flag = { flagStatus: changes.starred ? "flagged" : "notFlagged" };
        }
        if (changes.addLabels?.length || changes.removeLabels?.length) {
            const current = await this.call(`/messages/${enc(id)}`, {
                params: { $select: "categories" },
            });
            const remove = new Set((changes.removeLabels ?? []).map((c) => c.toLowerCase()));
            const cats = (current.categories ?? []).filter((c) => !remove.has(c.toLowerCase()));
            for (const c of changes.addLabels ?? []) {
                if (!cats.some((x) => x.toLowerCase() === c.toLowerCase()))
                    cats.push(c);
            }
            patch.categories = cats;
        }
        if (Object.keys(patch).length) {
            await this.call(`/messages/${enc(id)}`, { method: "PATCH", body: patch });
        }
        const destination = changes.trash
            ? "deleteditems"
            : changes.moveTo
                ? await this.folderId(changes.moveTo)
                : changes.archive
                    ? "archive"
                    : undefined;
        if (destination) {
            const moved = await this.call(`/messages/${enc(id)}/move`, {
                method: "POST",
                body: { destinationId: destination },
            });
            return { id: moved.id };
        }
        return { id };
    }
}
function enc(id) {
    return encodeURIComponent(id);
}
function addr(r) {
    const { name, address } = r.emailAddress;
    return name && name !== address ? { name, email: address } : { email: address };
}
function recipients(list) {
    return (list ?? []).map((raw) => {
        const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
        return m
            ? { emailAddress: { name: m[1].trim() || undefined, address: m[2].trim() } }
            : { emailAddress: { address: raw.trim() } };
    });
}
function newMessage(msg) {
    return {
        subject: msg.subject ?? "",
        body: { contentType: "Text", content: msg.body },
        toRecipients: recipients(msg.to),
        ccRecipients: recipients(msg.cc),
        bccRecipients: recipients(msg.bcc),
    };
}
/** Optional recipient/subject changes on a reply; Graph fills in the rest. */
function replyOverrides(msg) {
    const out = {};
    if (msg.to.length)
        out.toRecipients = recipients(msg.to);
    if (msg.cc?.length)
        out.ccRecipients = recipients(msg.cc);
    if (msg.bcc?.length)
        out.bccRecipients = recipients(msg.bcc);
    if (msg.subject)
        out.subject = msg.subject;
    return Object.keys(out).length ? out : undefined;
}
//# sourceMappingURL=outlook.js.map