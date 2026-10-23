import { z } from "zod";
import { ok, safe } from "./tools.js";

/**
 * Real SMS through Twilio, for reminder and alert texts. Set TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN and TWILIO_FROM (your Twilio number, e.g. +15551234567).
 * TEXT_ALLOWED_TO limits who can be texted (comma-separated numbers); by default
 * it's only the owner's own number in OWNER_PHONE, so this can't be used to text strangers.
 */
function e164(n) {
    const digits = String(n).replace(/[^\d+]/g, "");
    if (/^\+\d{8,15}$/.test(digits)) return digits;
    if (/^\d{10}$/.test(digits)) return `+1${digits}`;
    if (/^1\d{10}$/.test(digits)) return `+${digits}`;
    throw new Error(`"${n}" doesn't look like a phone number.`);
}

function settings() {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) {
        throw new Error("Texting isn't set up on this server yet: add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (see the setup guide).");
    }
    const allowed = (process.env.TEXT_ALLOWED_TO || process.env.OWNER_PHONE || "")
        .split(",").map((s) => s.trim()).filter(Boolean).map(e164);
    return { sid, token, from: e164(from), allowed };
}

export async function sendText(to, body) {
    const s = settings();
    const target = e164(to);
    if (!s.allowed.includes(target)) {
        throw new Error(`Texts can only go to the numbers set in TEXT_ALLOWED_TO / OWNER_PHONE on this server.`);
    }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.sid)}/Messages.json`, {
        method: "POST",
        headers: {
            Authorization: "Basic " + Buffer.from(`${s.sid}:${s.token}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: target, From: s.from, Body: String(body).slice(0, 640) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio didn't send it: ${data.message || res.status}`);
    return { sid: data.sid, status: data.status };
}

export function registerTextTools(server) {
    server.registerTool("send_text", {
        title: "Send a text message",
        description: "Send an SMS text, for reminders and alerts the person set up. Only numbers allowed on this " +
            "server (normally the owner's own phone) can receive texts. Leave `to` empty to text the owner.",
        inputSchema: {
            to: z.string().optional().describe("Phone number. Leave empty to text the owner's own phone."),
            body: z.string().describe("The message. Keep it short; long texts are cut at 640 characters."),
        },
        annotations: { openWorldHint: true },
    }, safe(async ({ to, body }) => {
        const target = to || process.env.OWNER_PHONE;
        if (!target) throw new Error("No number given and OWNER_PHONE isn't set on this server.");
        const r = await sendText(target, body);
        return ok({ sent: true, ...r });
    }));
}
