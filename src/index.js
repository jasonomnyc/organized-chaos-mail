#!/usr/bin/env node
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { registerCalendarTools } from "./calendarTools.js";
import { registerTools } from "./tools.js";
import { registerTextTools } from "./textTools.js";
import { registerInviteTools } from "./invite.js";
import { registerSlackTools, finishSlackSignIn, slackRedirectUri, slackSummary } from "./slack.js";
import { OwnerAuthProvider, passwordMatches } from "./ownerAuth.js";
import { baseUrl } from "./auth/appKeys.js";
import { finishGoogleSignIn, googleRedirectUri } from "./auth/google.js";
import { finishMicrosoftSignIn, microsoftRedirectUri } from "./auth/microsoft.js";
import { SUCCESS_PAGE, errorPage, escapeHtml, page } from "./auth/pages.js";
import { importDesktop } from "./importDesktop.js";
import { loadConfig } from "./config.js";
import { importPage } from "./importPage.js";

const INSTRUCTIONS = "This server connects several separate email inboxes (Gmail and Microsoft). Each inbox has " +
    "a nickname; call list_accounts to see them and their descriptions, then pass the nickname " +
    "to every other tool. Each inbox has a permission level (read, draft or send) that the " +
    "person controls; don't change it unless they ask. Each inbox's calendar uses the same " +
    "nickname and permission: read sees events, draft also makes and edits events that " +
    "involve no one else, and send is needed for anything that emails other people " +
    "(invites, updates to their meetings, accepting or declining). Slack workspaces are separate: " +
    "call slack_list_workspaces and pass a workspace nickname to the slack_ tools; use slack_activity " +
    "to see new DMs and @mentions that need the person.";

function buildMcpServer() {
    const server = new McpServer({ name: "organized-chaos-mail", version: "1.0.0" }, { instructions: INSTRUCTIONS });
    registerTools(server);
    registerCalendarTools(server);
    registerTextTools(server);
    registerInviteTools(server);
    registerSlackTools(server);
    return server;
}

function checkSettings() {
    const problems = [];
    if (!process.env.SECRET_KEY || process.env.SECRET_KEY.length < 24) problems.push("SECRET_KEY (at least 24 random characters)");
    if (!process.env.OWNER_PASSWORD || process.env.OWNER_PASSWORD.length < 10) problems.push("OWNER_PASSWORD (at least 10 characters)");
    return problems;
}

const base = baseUrl();
const mcpUrl = new URL(`${base}/mcp`);
const provider = new OwnerAuthProvider();
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.get("/health", (_req, res) => res.json({ ok: true }));

// OAuth endpoints Claude uses to connect (registration, authorize, token, metadata).
app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(base),
    resourceServerUrl: mcpUrl,
    resourceName: "Organized Chaos Mail",
    scopesSupported: ["mail"],
}));

app.post("/login", express.urlencoded({ extended: false, limit: "10kb" }), (req, res, next) => {
    provider.completeLogin(String(req.body.login_id ?? ""), req.body.password, res).catch(next);
});

// The MCP endpoint itself — locked behind the owner login.
const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
});
app.all("/mcp", bearer, express.json({ limit: "40mb" }), async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
        transport.close().catch(() => { });
        server.close().catch(() => { });
    });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }
    catch (err) {
        if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err?.message ?? err) }, id: null });
    }
});

// Google / Microsoft send people back here after they sign in to an inbox.
app.get("/oauth/google/callback", async (req, res) => {
    try {
        await finishGoogleSignIn(new URL(req.originalUrl, base).searchParams);
        res.type("html").send(SUCCESS_PAGE);
    }
    catch (err) {
        res.status(400).type("html").send(errorPage(err?.message ?? String(err)));
    }
});
app.get("/oauth/microsoft/callback", async (req, res) => {
    try {
        await finishMicrosoftSignIn(new URL(req.originalUrl, base).searchParams);
        res.type("html").send(SUCCESS_PAGE);
    }
    catch (err) {
        res.status(400).type("html").send(errorPage(err?.message ?? String(err)));
    }
});

app.get("/oauth/slack/callback", async (req, res) => {
    try {
        await finishSlackSignIn(new URL(req.originalUrl, base).searchParams);
        res.type("html").send(page("Slack is connected", "<p>That workspace is connected. You can close this tab and go back to Claude.</p>"));
    }
    catch (err) {
        res.status(400).type("html").send(errorPage(err?.message ?? String(err)));
    }
});

// Bring inboxes over from the desktop version without signing in again.
app.get("/import", (_req, res) => res.type("html").send(importPage()));
let importTries = 0;
setInterval(() => (importTries = 0), 15 * 60 * 1000).unref();
app.post("/import", express.json({ limit: "20mb" }), async (req, res) => {
    if (importTries >= 10) return res.status(429).json({ error: "Too many tries. Wait 15 minutes." });
    if (!passwordMatches(req.body?.password)) {
        importTries += 1;
        await new Promise((r) => setTimeout(r, 1000));
        return res.status(401).json({ error: "That owner password isn't right." });
    }
    try {
        const result = await importDesktop(req.body.files ?? {}, req.body.keys ?? {});
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err?.message ?? String(err) });
    }
});

// A plain status page with the values the setup guide asks you to copy.
app.get("/", async (_req, res) => {
    const problems = checkSettings();
    let inboxes = "";
    if (!problems.length) {
        try {
            const config = await loadConfig();
            const sl = await slackSummary();
            inboxes = `<p>${config.accounts.length} inbox${config.accounts.length === 1 ? "" : "es"} and ${sl} Slack workspace${sl === 1 ? "" : "s"} connected.</p>`;
        }
        catch (err) {
            inboxes = `<p class="err">Couldn't read saved data: ${escapeHtml(err.message)}</p>`;
        }
    }
    res.type("html").send(page("Your mail server is running", `
${problems.length ? `<p class="err">Still needs these settings: ${problems.map(escapeHtml).join(", ")}.</p>` : `<p class="ok">Settings look good.</p>`}
${inboxes}
<label>Connector URL (paste into Claude)</label><p><code>${escapeHtml(mcpUrl.href)}</code></p>
<label>Google redirect URI</label><p><code>${escapeHtml(googleRedirectUri())}</code></p>
<label>Microsoft redirect URI</label><p><code>${escapeHtml(microsoftRedirectUri())}</code></p>
<label>Slack redirect URL</label><p><code>${escapeHtml(slackRedirectUri())}</code></p>
<p><a href="/import">Import inboxes from the desktop version →</a></p>`));
});

const port = Number(process.env.PORT || 8080);
const problems = checkSettings();
if (problems.length) console.warn(`Missing settings: ${problems.join(", ")}. The connector stays locked until they're set.`);
app.listen(port, () => console.log(`Organized Chaos Mail listening on ${port} — ${mcpUrl.href}`));
