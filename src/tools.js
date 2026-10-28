import { z } from "zod";
import { effectivePermission, findAccount, loadConfig, PermissionLevel, permissionFromEnv, requirePermission, updateConfig, } from "./config.js";
import { beginAddAccount, editAccount, pendingSignIns, removeAccount } from "./accounts.js";
import { providerFor } from "./providers/index.js";
import { guessMime } from "./mime.js";
/** Largest single file get_attachment hands back. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export function ok(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: "text", text }] };
}
function fail(err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
}
/** Wraps a handler so any thrown error becomes a readable tool error. */
export function safe(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (err) {
            return fail(err);
        }
    };
}
async function open(nickname, needed, action) {
    const config = await loadConfig();
    const account = findAccount(config, nickname);
    requirePermission(config, account, needed, action);
    return { config, account, mail: await providerFor(config, account) };
}
const PROVIDER_LABEL = { gmail: "Gmail", microsoft: "Microsoft", icloud: "iCloud" };
/** Sending from another address only works where the inbox has aliases (iCloud). */
function checkFrom(account, from) {
    if (!from) return;
    const e = (String(from).match(/<([^>]+)>/)?.[1] ?? String(from)).trim().toLowerCase();
    if (e === account.email.toLowerCase()) return;
    if (account.provider !== "icloud") throw new Error(`Sending from another address works for iCloud inboxes only. "${account.nickname}" sends from ${account.email}.`);
}
export const inbox = z
    .string()
    .describe('The inbox nickname, as shown by list_accounts (for example "Work").');
const recipientList = z
    .array(z.string())
    .optional()
    .describe('Email addresses, optionally with a name: "Sam Lee <sam@example.com>".');
const composeFields = {
    inbox,
    to: recipientList.describe("Recipients. Leave empty when replying to send to the original sender (or everyone, with reply_all)."),
    cc: recipientList,
    bcc: recipientList,
    subject: z.string().optional().describe('Subject. When replying, defaults to "Re: <original>".'),
    body: z.string().describe("The message, as plain text."),
    reply_to_email_id: z
        .string()
        .optional()
        .describe("Reply to this email (an id from search_emails). Keeps the reply in the same thread."),
    reply_all: z.boolean().optional().describe("When replying, include everyone on the original."),
    attachments: z
        .array(z.object({
        filename: z.string(),
        content_base64: z.string().describe("The file's bytes, base64-encoded."),
        mime_type: z.string().optional().describe("Worked out from the filename when left out."),
    }))
        .optional()
        .describe("Files to attach. Up to about 18 MB in total."),
    include_attachments_from_email_id: z
        .string()
        .optional()
        .describe("Copy every attachment from this email (in the same inbox) onto this message, for example when forwarding it."),
    from: z
        .string()
        .optional()
        .describe("iCloud inboxes: send from this alias (one of the inbox's addresses in list_accounts). Replies to mail sent to an alias use that alias automatically."),
};
function toOutgoing(args) {
    return {
        to: args.to ?? [],
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        replyToId: args.reply_to_email_id,
        replyAll: args.reply_all,
        attachments: (args.attachments ?? []).map((a) => ({
            filename: a.filename,
            mimeType: a.mime_type || guessMime(a.filename),
            data: Buffer.from(a.content_base64, "base64"),
        })),
        includeAttachmentsFrom: args.include_attachments_from_email_id,
        from: args.from,
    };
}
export function registerTools(server) {
    // ---------- Inboxes and settings ----------
    server.registerTool("list_accounts", {
        title: "List connected inboxes",
        description: "List every connected inbox with its nickname, provider, address, description and what " +
            "Claude may do with it (read, draft or send). Call this first to choose the right inbox. " +
            "Also shows sign-ins that are still waiting in the browser.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, safe(async () => {
        const config = await loadConfig();
        return ok({
            default_permission: config.permission,
            inboxes: config.accounts.map((a) => ({
                nickname: a.nickname,
                provider: PROVIDER_LABEL[a.provider] ?? a.provider,
                email: a.email,
                ...(a.provider === "icloud" ? { aliases: a.onlyAddress ? [] : (a.aliases ?? []), send_as: a.onlyAddress ? a.email : (a.sendAs ?? a.email), sender_name: a.senderName ?? null, only_this_address: !!a.onlyAddress } : {}),
                description: a.description ?? null,
                permission: effectivePermission(config, a),
            })),
            pending_sign_ins: pendingSignIns(),
            permission_levels: {
                read: "search and read only",
                draft: "read, write drafts, and organize (labels, folders, read/unread, archive, trash)",
                send: "everything, including sending email",
            },
        });
    }));
    server.registerTool("add_account", {
        title: "Connect an inbox",
        description: "Connect a Gmail, Microsoft (Microsoft 365 or Outlook.com) or iCloud Mail inbox. Returns a sign-in link " +
            "to give the person. iCloud uses an app-specific password and can send from aliases; the person types " +
            "the password on the linked page, never in chat. The inbox appears in " +
            "list_accounts once they finish signing in.",
        inputSchema: {
            provider: z.enum(["gmail", "microsoft", "icloud"]),
            nickname: z
                .string()
                .describe('A short name the person chooses, like "Work" or "Personal".'),
            description: z
                .string()
                .optional()
                .describe('What this inbox is for, to help pick it later, e.g. "family and bills".'),
        },
    }, safe(async ({ provider, nickname, description }) => {
        const signIn = await beginAddAccount(provider, nickname, description);
        if (provider === "icloud") return ok(`To finish connecting "${signIn.nickname}", open this link and enter the iCloud address, an app-specific password ` +
            `(made at account.apple.com › Sign-In and Security › App-Specific Passwords) and any aliases to send from. It expires in 30 minutes:\n${signIn.url}\n` +
            `Once they've finished, call list_accounts to confirm "${signIn.nickname}" is connected.`);
        return ok(`To finish connecting "${signIn.nickname}", open this link and sign in to ${provider === "gmail" ? "Google" : "Microsoft"} ` +
            `(it works from a phone or computer, and expires in 15 minutes):\n${signIn.url}\n` +
            `Once they've finished, call list_accounts to confirm "${signIn.nickname}" is connected.`);
    }));
    server.registerTool("update_account", {
        title: "Rename or change an inbox's settings",
        description: "Change an inbox's nickname, description, or permission level. Only change the permission " +
            'when the person explicitly asks to. Use "default" to follow the global setting.',
        inputSchema: {
            inbox,
            new_nickname: z.string().optional(),
            description: z.string().optional().describe("New description; empty text clears it."),
            permission: z.enum(["read", "draft", "send", "default"]).optional(),
            aliases: z.array(z.string()).optional().describe("iCloud only: every alias this inbox may send from (replaces the list)."),
            send_as: z.string().optional().describe("iCloud only: the address new emails come from by default."),
            sender_name: z.string().optional().describe("iCloud only: the name shown on sent mail; empty clears it."),
        },
        annotations: { idempotentHint: true },
    }, safe(async ({ inbox, new_nickname, description, permission, aliases, send_as, sender_name }) => {
        const account = await editAccount(inbox, {
            newNickname: new_nickname,
            description,
            permission,
            aliases,
            sendAs: send_as,
            senderName: sender_name,
        });
        const config = await loadConfig();
        return ok({
            nickname: account.nickname,
            description: account.description ?? null,
            permission: effectivePermission(config, account),
            ...(account.provider === "icloud" ? { aliases: account.aliases ?? [], send_as: account.sendAs ?? account.email, sender_name: account.senderName ?? null } : {}),
        });
    }));
    server.registerTool("set_default_permission", {
        title: "Change the default permission",
        description: "Set what Claude may do with inboxes that don't have their own setting: read, draft or " +
            "send. Only use this when the person explicitly asks to.",
        inputSchema: { permission: PermissionLevel },
        annotations: { idempotentHint: true },
    }, safe(async ({ permission }) => {
        if (permissionFromEnv()) {
            throw new Error("The default permission is set in the Claude Desktop extension settings, so change it there.");
        }
        await updateConfig((c) => {
            c.permission = permission;
        });
        return ok(`The default permission is now "${permission}".`);
    }));
    server.registerTool("remove_account", {
        title: "Disconnect an inbox",
        description: "Disconnect an inbox and delete its saved sign-in from this computer. No email is deleted.",
        inputSchema: { inbox },
        annotations: { destructiveHint: true },
    }, safe(async ({ inbox }) => {
        const removed = await removeAccount(inbox);
        return ok(`Disconnected "${removed.nickname}" (${removed.email}).`);
    }));
    // ---------- Reading ----------
    server.registerTool("search_emails", {
        title: "Search emails",
        description: 'Search one inbox, or every inbox with inbox "all". With no query, returns the newest ' +
            "emails. Gmail accepts Gmail search syntax (from:, subject:, after:2026/01/01, " +
            "has:attachment); Microsoft accepts Outlook search syntax (from:, subject:, received:). " +
            "Plain words work for both. Each result says which inbox it came from.",
        inputSchema: {
            inbox: inbox.describe('An inbox nickname, or "all" to search every inbox.'),
            query: z.string().optional(),
            folder: z
                .string()
                .optional()
                .describe('Limit to a folder or label, e.g. "Inbox", "Sent", "Archive", or a custom one.'),
            unread_only: z.boolean().optional(),
            max_results: z.number().int().min(1).max(50).default(20).describe("Per inbox."),
        },
        annotations: { readOnlyHint: true },
    }, safe(async ({ inbox, query, folder, unread_only, max_results }) => {
        const config = await loadConfig();
        const targets = inbox.trim().toLowerCase() === "all" ? config.accounts : [findAccount(config, inbox)];
        if (!targets.length)
            throw new Error("No inboxes are connected yet. Use add_account first.");
        const opts = { query, folder, unreadOnly: unread_only, maxResults: max_results };
        const results = await Promise.all(targets.map(async (account) => {
            try {
                const mail = await providerFor(config, account);
                const emails = await mail.search(opts);
                return { inbox: account.nickname, emails };
            }
            catch (err) {
                return {
                    inbox: account.nickname,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }));
        if (results.length === 1 && "error" in results[0])
            throw new Error(results[0].error);
        return ok(results);
    }));
    server.registerTool("get_email", {
        title: "Read an email",
        description: "Read one email in full: sender, recipients, body text and attachment names.",
        inputSchema: { inbox, email_id: z.string() },
        annotations: { readOnlyHint: true },
    }, safe(async ({ inbox, email_id }) => {
        const { account, mail } = await open(inbox, "read", "read email");
        return ok({ inbox: account.nickname, ...(await mail.getEmail(email_id)) });
    }));
    server.registerTool("get_thread", {
        title: "Read a conversation",
        description: "Read every email in a conversation, oldest first. Use the threadId from search.",
        inputSchema: { inbox, thread_id: z.string() },
        annotations: { readOnlyHint: true },
    }, safe(async ({ inbox, thread_id }) => {
        const { account, mail } = await open(inbox, "read", "read email");
        return ok({ inbox: account.nickname, emails: await mail.getThread(thread_id) });
    }));
    server.registerTool("get_attachment", {
        title: "Download an attachment",
        description: "Get one attachment's file, base64-encoded, by the attachment id from get_email or get_thread " +
            "(or by its filename). Files over 25 MB aren't returned.",
        inputSchema: {
            inbox,
            email_id: z.string(),
            attachment_id: z.string().optional(),
            filename: z.string().optional().describe("Finds the attachment by name when the id is unknown or stale."),
        },
        annotations: { readOnlyHint: true },
    }, safe(async ({ inbox, email_id, attachment_id, filename }) => {
        if (!attachment_id && !filename)
            throw new Error("Give the attachment_id or the filename.");
        const { account, mail } = await open(inbox, "read", "read email");
        const file = await mail.getAttachment(email_id, { id: attachment_id, filename });
        if (file.data.length > MAX_DOWNLOAD_BYTES)
            throw new Error(`"${file.filename}" is ${(file.data.length / 1048576).toFixed(1)} MB, too large to download here. Open it in your mail app.`);
        return ok({
            inbox: account.nickname,
            filename: file.filename,
            mime_type: file.mimeType,
            size: file.data.length,
            content_base64: file.data.toString("base64"),
        });
    }));
    server.registerTool("list_folders", {
        title: "List folders and labels",
        description: "List an inbox's folders (Microsoft) or labels (Gmail), with unread counts where available.",
        inputSchema: { inbox },
        annotations: { readOnlyHint: true },
    }, safe(async ({ inbox }) => {
        const { account, mail } = await open(inbox, "read", "list folders");
        return ok({ inbox: account.nickname, folders: await mail.listFolders() });
    }));
    // ---------- Drafting and organizing ----------
    server.registerTool("create_draft", {
        title: "Write a draft",
        description: "Save a draft in the inbox's Drafts folder without sending it. Works for new emails and " +
            "replies. The person can review it in their email app, or send it later with send_draft.",
        inputSchema: composeFields,
    }, safe(async (args) => {
        const { account, mail } = await open(args.inbox, "draft", "write drafts");
        checkFrom(account, args.from);
        const draft = await mail.createDraft(toOutgoing(args));
        return ok({ inbox: account.nickname, draft });
    }));
    server.registerTool("update_email", {
        title: "Organize an email",
        description: "Mark read or unread, star or flag, archive, move to trash, move to a folder, or add and " +
            "remove labels (Gmail labels, or Microsoft categories). A missing Gmail label is created. " +
            "Microsoft gives a moved email a new id, which is returned.",
        inputSchema: {
            inbox,
            email_id: z.string(),
            mark_read: z.boolean().optional().describe("true marks read, false marks unread."),
            star: z.boolean().optional().describe("Star (Gmail) or flag (Microsoft)."),
            archive: z.boolean().optional(),
            trash: z.boolean().optional().describe("Move to trash. It can be recovered from there."),
            move_to_folder: z.string().optional(),
            add_labels: z.array(z.string()).optional(),
            remove_labels: z.array(z.string()).optional(),
        },
        annotations: { idempotentHint: true },
    }, safe(async (args) => {
        const { account, mail } = await open(args.inbox, "draft", "organize email");
        const result = await mail.update(args.email_id, {
            read: args.mark_read,
            starred: args.star,
            archive: args.archive,
            trash: args.trash,
            moveTo: args.move_to_folder,
            addLabels: args.add_labels,
            removeLabels: args.remove_labels,
        });
        return ok({ inbox: account.nickname, email_id: result.id, updated: true });
    }));
    // ---------- Sending ----------
    server.registerTool("send_email", {
        title: "Send an email",
        description: "Send an email right away, as a new message or a reply. Confirm the recipients and wording " +
            "with the person first unless they've clearly asked to send without checking.",
        inputSchema: composeFields,
        annotations: { destructiveHint: true, openWorldHint: true },
    }, safe(async (args) => {
        const { account, mail } = await open(args.inbox, "send", "send email");
        checkFrom(account, args.from);
        await mail.send(toOutgoing(args));
        return ok(`Sent from "${account.nickname}" (${args.from || account.email}).`);
    }));
    server.registerTool("send_draft", {
        title: "Send a draft",
        description: "Send a draft that's already saved. Use the draft id from create_draft.",
        inputSchema: { inbox, draft_id: z.string() },
        annotations: { destructiveHint: true, openWorldHint: true },
    }, safe(async ({ inbox, draft_id }) => {
        const { account, mail } = await open(inbox, "send", "send email");
        await mail.sendDraft(draft_id);
        return ok(`Draft sent from "${account.nickname}" (${account.email}).`);
    }));
}
//# sourceMappingURL=tools.js.map