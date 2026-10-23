import { randomUUID } from "node:crypto";
import { findAccount, loadConfig, updateConfig, } from "./config.js";
import { forgetGoogleClient, startGoogleSignIn } from "./auth/google.js";
import { removeMicrosoftAccount, startMicrosoftSignIn } from "./auth/microsoft.js";
import { deleteToken, writeToken } from "./auth/tokenStore.js";
import { forgetProvider } from "./providers/index.js";
/** Sign-ins started by add_account that haven't finished, or failed recently. */
const pending = new Map();
export function pendingSignIns() {
    return [...pending.values()];
}
export function validateNickname(nickname) {
    const name = nickname.trim();
    if (!name || name.length > 40)
        throw new Error("A nickname must be 1 to 40 characters.");
    if (name.toLowerCase() === "all")
        throw new Error('"all" is reserved for searching every inbox.');
    return name;
}
/**
 * Opens the browser to sign in and returns right away with the link; the
 * account is saved in the background once the person finishes.
 */
export async function beginAddAccount(provider, nicknameIn, description) {
    const nickname = validateNickname(nicknameIn);
    const config = await loadConfig();
    const key = nickname.toLowerCase();
    if (config.accounts.some((a) => a.nickname.toLowerCase() === key)) {
        throw new Error(`There's already an inbox called "${nickname}". Pick another nickname.`);
    }
    if (pending.get(key)?.status === "waiting") {
        throw new Error(`A sign-in for "${nickname}" is already waiting in the browser.`);
    }
    const entry = { nickname, provider, status: "waiting", url: "" };
    const fail = (err) => {
        entry.status = "failed";
        entry.error = err instanceof Error ? err.message : String(err);
    };
    pending.set(key, entry);
    try {
        if (provider === "gmail") {
            const signIn = await startGoogleSignIn(config);
            entry.url = signIn.url;
            signIn.done
                .then(async ({ email, tokens }) => {
                // Save the token before the account so it's never listed without one.
                const id = randomUUID();
                await writeToken(id, tokens);
                await saveAccount({ id, provider, nickname, description, email });
                pending.delete(key);
            })
                .catch(fail);
        }
        else {
            const signIn = startMicrosoftSignIn(config);
            signIn.done
                .then(async ({ email, homeAccountId }) => {
                await saveAccount({
                    id: randomUUID(),
                    provider,
                    nickname,
                    description,
                    email,
                    homeAccountId,
                });
                pending.delete(key);
            })
                .catch(fail);
            entry.url = await Promise.race([
                signIn.url,
                new Promise((r) => setTimeout(() => r(""), 15_000)),
            ]);
            if (entry.status === "failed")
                throw new Error(entry.error);
        }
    }
    catch (err) {
        pending.delete(key);
        throw err;
    }
    return entry;
}
/** Adds the account, or refreshes it if this address is already connected. */
async function saveAccount(input) {
    let saved;
    let replacedId;
    await updateConfig((config) => {
        const existing = config.accounts.find((a) => a.provider === input.provider && a.email.toLowerCase() === input.email.toLowerCase());
        if (existing) {
            if (input.provider === "gmail") {
                replacedId = existing.id;
                existing.id = input.id;
            }
            existing.nickname = input.nickname;
            if (input.description !== undefined)
                existing.description = input.description;
            if (input.homeAccountId)
                existing.homeAccountId = input.homeAccountId;
            saved = existing;
        }
        else {
            if (config.accounts.some((a) => a.nickname.toLowerCase() === input.nickname.toLowerCase())) {
                throw new Error(`There's already an inbox called "${input.nickname}".`);
            }
            saved = { ...input };
            config.accounts.push(saved);
        }
    });
    if (replacedId) {
        forgetProvider(replacedId);
        forgetGoogleClient(replacedId);
        await deleteToken(replacedId);
    }
    forgetProvider(saved.id);
    return saved;
}
export async function editAccount(nickname, changes) {
    let result;
    await updateConfig((config) => {
        const account = findAccount(config, nickname);
        if (changes.newNickname !== undefined) {
            const name = validateNickname(changes.newNickname);
            const clash = config.accounts.find((a) => a !== account && a.nickname.toLowerCase() === name.toLowerCase());
            if (clash)
                throw new Error(`There's already an inbox called "${name}".`);
            account.nickname = name;
        }
        if (changes.description !== undefined) {
            account.description = changes.description.trim() || undefined;
        }
        if (changes.permission === "default")
            delete account.permission;
        else if (changes.permission)
            account.permission = changes.permission;
        result = account;
    });
    return result;
}
export async function removeAccount(nickname) {
    let removed;
    const config = await updateConfig((c) => {
        removed = findAccount(c, nickname);
        c.accounts = c.accounts.filter((a) => a !== removed);
    });
    forgetProvider(removed.id);
    if (removed.provider === "gmail") {
        forgetGoogleClient(removed.id);
        await deleteToken(removed.id);
    }
    else if (removed.homeAccountId) {
        await removeMicrosoftAccount(config, removed.homeAccountId).catch(() => { });
    }
    return removed;
}
//# sourceMappingURL=accounts.js.map