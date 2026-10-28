import { randomUUID } from "node:crypto";
import { findAccount, loadConfig, updateConfig, } from "./config.js";
import { forgetGoogleClient, startGoogleSignIn } from "./auth/google.js";
import { removeMicrosoftAccount, startMicrosoftSignIn } from "./auth/microsoft.js";
import { deleteToken, writeToken } from "./auth/tokenStore.js";
import { forgetProvider } from "./providers/index.js";
import { randomBytes } from "node:crypto";
import { baseUrl } from "./auth/appKeys.js";
import { escapeHtml, page } from "./auth/pages.js";
import { verifyIcloud } from "./providers/icloud.js";
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
        if (provider === "icloud") {
            const k = randomBytes(24).toString("base64url");
            entry.url = `${baseUrl()}/icloud/connect?k=${k}`;
            icloudLinks.set(k, { key, nickname, description, expires: Date.now() + 30 * 60_000 });
            setTimeout(() => { if (icloudLinks.has(k)) { icloudLinks.delete(k); if (pending.get(key) === entry) pending.delete(key); } }, 30 * 60_000).unref();
            return entry;
        }
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
/** iCloud sign-in links waiting for the person to enter their app-specific password. */
const icloudLinks = new Map();
function cleanAddr(s) { return String(s ?? "").trim().replace(/^.*<([^>]+)>.*$/, "$1").toLowerCase(); }
const ADDR = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function icloudForm(k, error, prev = {}) {
    const link = icloudLinks.get(k);
    if (!link || link.expires < Date.now()) return page("This link expired", "<p>Start adding the iCloud inbox again from Organized Chaos.</p>");
    const only = prev.only === undefined ? true : prev.only === "on";
    return page(`Connect iCloud mail: ${link.nickname}`, `
<p>You need an <b>app-specific password</b>, not your Apple Account password. Make one at
<a href="https://account.apple.com" target="_blank" rel="noopener">account.apple.com</a> › Sign-In and Security › App-Specific Passwords.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/icloud/connect">
<input type="hidden" name="k" value="${escapeHtml(k)}">
<label for="em">Address to use in Organized Chaos</label>
<input id="em" type="text" name="email" inputmode="email" value="${escapeHtml(prev.email ?? "")}" placeholder="you@yourdomain.com" required>
<small>The address you send from and receive at. It can be an alias or a custom-domain address on your iCloud account.</small>
<label for="lg">iCloud Mail address to sign in with</label>
<input id="lg" type="text" name="login" inputmode="email" autocomplete="username" value="${escapeHtml(prev.login ?? "")}" placeholder="yourname@icloud.com">
<small>Your iCloud Mail address (ending in @icloud.com), used only to sign in. iCloud's mail servers don't accept an Apple Account name that isn't an iCloud address. Leave blank if it's the same as above.</small>
<label for="pw">App-specific password</label>
<input id="pw" type="password" name="password" autocomplete="off" placeholder="xxxx-xxxx-xxxx-xxxx" required>
<label style="display:flex;gap:8px;align-items:flex-start;font-weight:600"><input type="checkbox" name="only" ${only ? "checked" : ""} style="margin-top:4px">
<span>Only show mail sent to this address, and always send from it<br><small style="font-weight:400">Mail to your other iCloud addresses stays out of Organized Chaos.</small></span></label>
<label for="al">Other aliases to send from <small>(only when the box above is off; comma separated)</small></label>
<input id="al" type="text" name="aliases" value="${escapeHtml(prev.aliases ?? "")}" placeholder="optional">
<label for="nm">Name on sent mail <small>(optional)</small></label>
<input id="nm" type="text" name="sender_name" value="${escapeHtml(prev.sender_name ?? "")}" placeholder="Jay">
<button type="submit">Connect</button>
<p><small>The password is checked with iCloud, then kept encrypted on your mail server. Revoke it any time from your Apple Account.</small></p>
</form>`);
}
export async function finishIcloudSignIn(k, form) {
    const link = icloudLinks.get(k);
    if (!link || link.expires < Date.now()) throw new Error("This link expired. Start again from Organized Chaos.");
    const email = cleanAddr(form.email);
    let login = String(form.login ?? "").trim().toLowerCase();
    const password = String(form.password ?? "").trim();
    const onlyAddress = form.only === "on";
    if (!ADDR.test(email)) throw new Error("That doesn't look like an email address.");
    if (!password) throw new Error("Enter the app-specific password.");
    if (login && !login.includes("@") && !/^[a-z0-9._+-]+$/.test(login)) throw new Error("Enter your iCloud Mail address, like yourname@icloud.com.");
    if (login === email) login = "";
    const aliases = onlyAddress ? [] : [...new Set(String(form.aliases ?? "").split(/[,\s;]+/).map(cleanAddr).filter((a) => a && a !== email))];
    for (const a of aliases) if (!ADDR.test(a)) throw new Error(`"${a}" doesn't look like an email address.`);
    await verifyIcloud(email, password, {}, login || undefined);
    const config = await loadConfig();
    const existing = config.accounts.find((a) => a.provider === "icloud" && a.email.toLowerCase() === email);
    const id = existing?.id ?? randomUUID();
    await writeToken(id, { password });
    const saved = await saveAccount({ id, provider: "icloud", nickname: link.nickname, description: link.description, email, aliases,
        login: login || undefined, onlyAddress: onlyAddress || undefined, senderName: String(form.sender_name ?? "").trim() || undefined });
    icloudLinks.delete(k);
    pending.delete(link.key);
    return saved;
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
            if (input.provider === "icloud") {
                existing.aliases = input.aliases;
                existing.sendAs = input.sendAs;
                existing.senderName = input.senderName;
                existing.login = input.login;
                existing.onlyAddress = input.onlyAddress;
            }
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
        if (changes.aliases !== undefined || changes.sendAs !== undefined || changes.senderName !== undefined) {
            if (account.provider !== "icloud") throw new Error("Aliases are for iCloud inboxes only.");
            if (changes.aliases !== undefined) {
                const list = [...new Set(changes.aliases.map(cleanAddr).filter((a) => a && a !== account.email.toLowerCase()))];
                for (const a of list) if (!ADDR.test(a)) throw new Error(`"${a}" doesn't look like an email address.`);
                account.aliases = list;
            }
            if (changes.sendAs !== undefined) {
                const s = cleanAddr(changes.sendAs);
                if (!s || s === account.email.toLowerCase()) delete account.sendAs;
                else if (!(account.aliases ?? []).includes(s)) throw new Error(`${s} isn't one of this inbox's aliases. Add it to aliases first.`);
                else account.sendAs = s;
            }
            if (changes.senderName !== undefined) account.senderName = changes.senderName.trim() || undefined;
        }
        result = account;
    });
    forgetProvider(result.id);
    return result;
}
export async function removeAccount(nickname) {
    let removed;
    const config = await updateConfig((c) => {
        removed = findAccount(c, nickname);
        c.accounts = c.accounts.filter((a) => a !== removed);
    });
    forgetProvider(removed.id);
    if (removed.provider === "icloud") {
        await deleteToken(removed.id);
    }
    else if (removed.provider === "gmail") {
        forgetGoogleClient(removed.id);
        await deleteToken(removed.id);
    }
    else if (removed.homeAccountId) {
        await removeMicrosoftAccount(config, removed.homeAccountId).catch(() => { });
    }
    return removed;
}
//# sourceMappingURL=accounts.js.map