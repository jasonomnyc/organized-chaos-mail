/**
 * Google app keys.
 * - "web" keys (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) are used to sign in new
 *   Gmail inboxes through this server.
 * - "desktop" keys come from an imported desktop setup (config.google). They keep
 *   inboxes that were signed in on the desktop version working without signing in again.
 */
export function googleKeys(config, which = "web") {
    if (which === "desktop" && config.google?.clientId && config.google?.clientSecret) {
        return { clientId: config.google.clientId, clientSecret: config.google.clientSecret };
    }
    const clientId = process.env.GOOGLE_CLIENT_ID || process.env.EMAIL_MCP_GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.EMAIL_MCP_GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        if (which === "desktop") {
            throw new Error("This Gmail inbox was imported from the desktop version, but its Google app key " +
                "wasn't imported with it. Import the desktop config.json again, or sign this inbox in again.");
        }
        throw new Error("Gmail sign-in isn't set up on this server yet: set GOOGLE_CLIENT_ID and " +
            "GOOGLE_CLIENT_SECRET (see the setup guide).");
    }
    return { clientId, clientSecret };
}

export function microsoftClientId(config) {
    const clientId = process.env.MICROSOFT_CLIENT_ID ||
        process.env.EMAIL_MCP_MICROSOFT_CLIENT_ID ||
        config.microsoft?.clientId;
    if (!clientId) {
        throw new Error("Microsoft sign-in isn't set up on this server yet: set MICROSOFT_CLIENT_ID " +
            "(see the setup guide), or import your desktop config.json.");
    }
    return clientId;
}

/** The public https address of this server, e.g. https://oc-mail.up.railway.app */
export function baseUrl() {
    const raw = process.env.PUBLIC_URL ||
        (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "") ||
        `http://localhost:${process.env.PORT || 8080}`;
    return raw.replace(/\/+$/, "");
}
