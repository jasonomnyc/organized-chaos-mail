import { readJson, writeJson, dataDir as storeDir } from "./secureStore.js";
import { z } from "zod";
/**
 * What Claude is allowed to do with an inbox.
 * - read:  search and read only
 * - draft: read, plus create and edit drafts (nothing is sent)
 * - send:  everything, including sending email
 */
export const PermissionLevel = z.enum(["read", "draft", "send"]);
const LEVEL_RANK = { read: 0, draft: 1, send: 2 };
export const Provider = z.enum(["gmail", "microsoft", "icloud"]);
export const AccountSchema = z.object({
    /** Stable internal id; names the account's token file. */
    id: z.string(),
    /** Short name the person uses with Claude, e.g. "Work". Unique, case-insensitive. */
    nickname: z.string().min(1),
    provider: Provider,
    /** The email address, filled in after sign-in. */
    email: z.string().email(),
    /** Optional hint that helps Claude pick the right inbox, e.g. "family and bills". */
    description: z.string().optional(),
    /** Overrides the global permission level for this one inbox. */
    permission: PermissionLevel.optional(),
    /** Microsoft only: which signed-in account in the token cache this inbox uses. */
    homeAccountId: z.string().optional(),
    /** iCloud only: other addresses this inbox can send from, and the one new mail uses by default. */
    aliases: z.array(z.string()).optional(),
    sendAs: z.string().optional(),
    /** iCloud only: the name shown on mail it sends. */
    senderName: z.string().optional(),
    /** iCloud only: the iCloud Mail address (or its name part) used to sign in, when it differs from `email`. */
    login: z.string().optional(),
    /** iCloud only: show only mail sent to `email`, and always send from it. */
    onlyAddress: z.boolean().optional(),
});
export const ConfigSchema = z.object({
    permission: PermissionLevel.default("draft"),
    accounts: z.array(AccountSchema).default([]),
    /** App keys. Usually built in or set in the extension settings; listed here for self-hosters. */
    google: z.object({ clientId: z.string(), clientSecret: z.string() }).optional(),
    microsoft: z.object({ clientId: z.string() }).optional(),
});
/** All data lives in DATA_DIR (see secureStore.js). */
export function dataDir() {
    return storeDir();
}
/** A valid permission set in the Claude Desktop extension settings, if any. */
export function permissionFromEnv() {
    const parsed = PermissionLevel.safeParse(process.env.EMAIL_MCP_PERMISSION?.trim().toLowerCase());
    return parsed.success ? parsed.data : undefined;
}
export async function loadConfig() {
    const raw = (await readJson("config.json")) ?? {};
    const config = ConfigSchema.parse(raw);
    // A permission set in Claude Desktop's extension settings wins over the file.
    const fromEnv = permissionFromEnv();
    if (fromEnv)
        config.permission = fromEnv;
    return config;
}
/** Writes the config file. Settings that came from the environment are not written back. */
export async function saveConfig(config) {
    const onDisk = ConfigSchema.parse((await readJson("config.json")) ?? {});
    if (permissionFromEnv())
        config = { ...config, permission: onDisk.permission };
    await writeJson("config.json", config);
}
export function findAccount(config, nickname) {
    const match = config.accounts.find((a) => a.nickname.toLowerCase() === nickname.toLowerCase());
    if (!match) {
        const known = config.accounts.map((a) => `"${a.nickname}"`).join(", ") || "none yet";
        throw new Error(`No inbox called "${nickname}". Connected inboxes: ${known}.`);
    }
    return match;
}
/**
 * Load the config, apply a change, and save it. Re-reads from disk first so a
 * sign-in finishing in the background doesn't overwrite another change.
 */
export async function updateConfig(change) {
    const config = await loadConfig();
    change(config);
    await saveConfig(config);
    return config;
}
export function effectivePermission(config, account) {
    return account.permission ?? config.permission;
}
/** Throws a clear message when the inbox's permission level is too low for an action. */
export function requirePermission(config, account, needed, action) {
    const have = effectivePermission(config, account);
    if (LEVEL_RANK[have] < LEVEL_RANK[needed]) {
        throw new Error(`Can't ${action}: the "${account.nickname}" inbox is set to "${have}" access, ` +
            `and this needs "${needed}". Ask Claude to change it with update_account.`);
    }
}
//# sourceMappingURL=config.js.map