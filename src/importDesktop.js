import { ConfigSchema, loadConfig, saveConfig } from "./config.js";
import { writeToken } from "./auth/tokenStore.js";
import { forgetAllGoogleClients } from "./auth/google.js";
import { resetMicrosoft } from "./auth/microsoft.js";
import { forgetAllProviders } from "./providers/index.js";

/**
 * Brings a desktop setup (~/.email-mcp) across so its inboxes keep working
 * without signing in again. `files` maps relative paths ("config.json",
 * "tokens/<id>.json", "tokens/microsoft-cache.json") to their text.
 * Optional `keys` fills in app keys the desktop version kept in its extension settings.
 */
export async function importDesktop(files, keys = {}) {
    const rawConfig = files["config.json"];
    if (!rawConfig) throw new Error("config.json wasn't in the upload. Pick your whole .email-mcp folder.");
    const incoming = ConfigSchema.parse(JSON.parse(rawConfig));

    const google = keys.googleClientId && keys.googleClientSecret
        ? { clientId: keys.googleClientId.trim(), clientSecret: keys.googleClientSecret.trim() }
        : incoming.google;
    const microsoft = keys.microsoftClientId ? { clientId: keys.microsoftClientId.trim() } : incoming.microsoft;

    const needsGoogle = incoming.accounts.some((a) => a.provider === "gmail");
    const needsMicrosoft = incoming.accounts.some((a) => a.provider === "microsoft");
    if (needsGoogle && !google) {
        throw new Error("Your Gmail inboxes need the desktop version's Google client ID and secret to keep working. " +
            "Fill them in below (they're in Claude → Settings → Extensions → Email and Calendar).");
    }
    if (needsMicrosoft && !microsoft && !process.env.MICROSOFT_CLIENT_ID) {
        throw new Error("Your Microsoft inboxes need the desktop version's Microsoft client ID. Fill it in below.");
    }

    const imported = [];
    const skipped = [];
    for (const account of incoming.accounts) {
        if (account.provider === "gmail") {
            const raw = files[`tokens/${account.id}.json`];
            if (!raw) {
                skipped.push(`${account.nickname} (no sign-in file found)`);
                continue;
            }
            const tokens = JSON.parse(raw);
            await writeToken(account.id, { ...tokens, oc_client: "desktop" });
        }
        imported.push(account);
    }
    if (files["tokens/microsoft-cache.json"]) {
        await writeToken("microsoft-cache", JSON.parse(files["tokens/microsoft-cache.json"]));
    }
    else {
        for (const a of imported.filter((x) => x.provider === "microsoft")) skipped.push(`${a.nickname} (Microsoft sign-in file missing)`);
    }

    const current = await loadConfig();
    const merged = {
        ...current,
        permission: incoming.permission ?? current.permission,
        google: google ?? current.google,
        microsoft: microsoft ?? current.microsoft,
        accounts: [
            ...current.accounts.filter((a) => !imported.some((b) => b.email.toLowerCase() === a.email.toLowerCase() && b.provider === a.provider)),
            ...imported.filter((a) => !skipped.some((s) => s.startsWith(a.nickname + " "))),
        ],
    };
    await saveConfig(merged);
    forgetAllGoogleClients();
    forgetAllProviders();
    resetMicrosoft();
    return { imported: merged.accounts.map((a) => `${a.nickname} (${a.email})`), skipped };
}
