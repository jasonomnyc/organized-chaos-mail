import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { readJson, writeJson } from "./secureStore.js";
import { baseUrl } from "./auth/appKeys.js";
import { escapeHtml, page } from "./auth/pages.js";
import { ok, safe, openInbox } from "./tools.js";

/**
 * Phone notifications through ntfy (https://ntfy.sh), and the task reminders that use them.
 *
 * Organized Chaos sends its whole list of task alarms here (reminders_sync). This server works out when each one
 * goes off (repeats, hourly or daily nagging until done, quiet hours), hands each alert to ntfy up to 3 days ahead
 * as a scheduled message, and sends any reminder email or text at that moment. Each task keeps one ntfy sequence id,
 * so a changed time replaces the waiting message and a finished task cancels it. Notifications carry Done and
 * Snooze buttons that come back to this server.
 *
 * The ntfy access token is typed on this server's own page (/ntfy/connect), never in chat, and kept encrypted.
 */
const FILE = "notify.json";
const AHEAD = 3 * 24 * 3600e3 - 5 * 60e3; // ntfy.sh holds scheduled messages up to 3 days
const LATE = 3 * 3600e3; // an alert missed by more than this isn't sent late
const TICK = 30e3;
const DEFAULT_SERVER = "https://ntfy.sh";
const DEFAULT_TOPIC = "organized-chaos";

let state; // { settings:{server,topic,token,tz,quietStart,quietEnd,click}, reminders:{id:{...}}, log:[] }
let saving = Promise.resolve();
async function load() {
    if (!state) {
        state = (await readJson(FILE)) ?? {};
        state.settings ??= {};
        state.reminders ??= {};
        state.log ??= [];
    }
    return state;
}
function save() {
    saving = saving.then(() => writeJson(FILE, state)).catch((err) => console.error("notify save", err));
    return saving;
}
function note(line) {
    state.log.unshift(`${new Date().toISOString()} ${line}`);
    state.log.length = Math.min(state.log.length, 40);
}
function settings() {
    const s = state.settings;
    return {
        server: (s.server || process.env.NTFY_SERVER || DEFAULT_SERVER).replace(/\/+$/, ""),
        topic: s.topic || process.env.NTFY_TOPIC || DEFAULT_TOPIC,
        token: s.token || process.env.NTFY_TOKEN || "",
        tz: s.tz || "America/New_York",
        quietStart: Number.isFinite(s.quietStart) ? s.quietStart : 21,
        quietEnd: Number.isFinite(s.quietEnd) ? s.quietEnd : 7,
        click: s.click || "",
    };
}

/* ---------- ntfy ---------- */
async function ntfy(body, method = "POST", path = "") {
    const s = settings();
    const headers = { "Content-Type": "application/json" };
    if (s.token) headers.Authorization = `Bearer ${s.token}`;
    const res = await fetch(`${s.server}/${path}`, { method, headers, body: body ? JSON.stringify({ topic: s.topic, ...body }) : undefined, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!res.ok) {
        let msg = text.slice(0, 300);
        try { msg = JSON.parse(text).error || msg; } catch { }
        if (res.status === 401 || res.status === 403) throw new Error(`ntfy refused the message (${res.status}): ${msg}. Connect ntfy again with an access token that can write to "${s.topic}".`);
        throw new Error(`ntfy error ${res.status}: ${msg}`);
    }
    try { return JSON.parse(text); } catch { return {}; }
}
async function cancelSid(sid) {
    const s = settings();
    const headers = s.token ? { Authorization: `Bearer ${s.token}` } : {};
    const res = await fetch(`${s.server}/${encodeURIComponent(s.topic)}/${encodeURIComponent(sid)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok && res.status !== 404) throw new Error(`ntfy cancel ${res.status}`);
}
const PRIO = { urgent: 5, high: 4, normal: 3, low: 2 };
function sign(id, action) {
    return createHmac("sha256", `${process.env.SECRET_KEY}|ntfy`).update(`${id}|${action}`).digest("base64url").slice(0, 32);
}
function actionUrl(id, action) {
    return `${baseUrl()}/ntfy/act?id=${encodeURIComponent(id)}&a=${action}&s=${sign(id, action)}`;
}
function sidFor(id) {
    return `oc-${String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}`;
}
function reminderMessage(r, at) {
    const s = settings();
    const label = r.priority === "urgent" ? "URGENT: " : r.priority === "high" ? "High priority: " : "";
    const body = [r.notes ? String(r.notes).slice(0, 300) : "", r.client ? `Client: ${r.client}` : ""].filter(Boolean).join("\n");
    return {
        sequence_id: sidFor(r.id),
        title: `⏰ ${label}${r.title}`.slice(0, 250),
        message: body || `Due ${fmtLocal(+new Date(r.due), s.tz)}`,
        priority: PRIO[r.priority] ?? 3,
        tags: ["alarm_clock"],
        ...(s.click ? { click: s.click } : {}),
        actions: [
            { action: "http", label: "Done ✓", url: actionUrl(r.id, "done"), method: "POST", clear: true },
            { action: "http", label: "Snooze 1h", url: actionUrl(r.id, "snooze"), method: "POST", clear: true },
            ...(s.click ? [{ action: "view", label: "Open", url: s.click }] : []),
        ],
        ...(at ? { delay: String(Math.floor(at / 1000)) } : {}),
    };
}

/* ---------- time, in Jay's time zone ---------- */
function parts(ms, tz) {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday) };
}
/** The instant when the clock in tz reads this local time (overflowing days and months roll over, like Date does). */
function fromLocal(y, mo, d, h, mi, s, tz) {
    const want = Date.UTC(y, mo - 1, d, h, mi, s);
    let t = want;
    for (let i = 0; i < 3; i++) {
        const p = parts(t, tz);
        const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
        t += want - shown;
    }
    return t;
}
function fmtLocal(ms, tz) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}
function nextOccurrence(dueMs, freq, after, tz) {
    let p = parts(dueMs, tz);
    let t = dueMs;
    for (let guard = 0; t <= after && guard < 3000; guard++) {
        let { y, mo, d } = p;
        if (freq === "daily") d += 1;
        else if (freq === "weekdays") { d += 1; const wd = (p.wd + 1) % 7; if (wd === 6) d += 2; else if (wd === 0) d += 1; }
        else if (freq === "weekly") d += 7;
        else if (freq === "biweekly") d += 14;
        else if (freq === "monthly") mo += 1;
        else if (freq === "yearly") y += 1;
        else return dueMs;
        t = fromLocal(y, mo, d, p.h, p.mi, 0, tz);
        p = parts(t, tz);
    }
    return t;
}
function quiet(ms) {
    const s = settings();
    const p = parts(ms, s.tz);
    const qs = s.quietStart, qe = s.quietEnd;
    const inQ = qs > qe ? (p.h >= qs || p.h < qe) : (p.h >= qs && p.h < qe);
    if (!inQ) return ms;
    const nextDay = qs > qe && p.h >= qs;
    return fromLocal(p.y, p.mo, p.d + (nextDay ? 1 : 0), qe, 0, 0, s.tz);
}
const FOLLOW = { hourly: 3600e3, daily: 864e5, weekly: 7 * 864e5 };
/** The next follow-up after `last`: every hour (quiet hours skipped), every day at a set time, or every week on a set day and time. */
function nextFollow(r, last) {
    const s = settings();
    if (r.follow === "hourly") return quiet(last + 3600e3);
    const m = /^(\d{1,2}):(\d{2})$/.exec(r.followTime || "");
    const dueP = parts(+new Date(r.due), s.tz);
    const hh = m ? +m[1] : dueP.h, mi = m ? +m[2] : dueP.mi;
    if (r.follow === "daily" && !m) return quiet(last + 864e5);
    if (r.follow !== "daily" && r.follow !== "weekly") return null;
    const p = parts(last, s.tz);
    const dow = r.follow === "weekly" ? (Number.isInteger(r.followDow) ? r.followDow : dueP.wd) : null;
    for (let add = 0; add <= 8; add++) {
        const t = fromLocal(p.y, p.mo, p.d + add, hh, mi, 0, s.tz);
        if (t <= last + 60e3) continue;
        if (dow != null && parts(t, s.tz).wd !== dow) continue;
        return t;
    }
    return last + FOLLOW[r.follow];
}
/** When this reminder should next go off, or null. */
function nextAlert(r) {
    if (r.done || !r.due) return null;
    const due = +new Date(r.due);
    const last = r.lastNote ? +new Date(r.lastNote) : 0;
    if (r.snooze && r.snooze > last) return r.snooze;
    if (last < due) return due;
    return FOLLOW[r.follow] ? nextFollow(r, last) : null;
}

/* ---------- the scheduler ---------- */
let ticking = false;
async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        await load();
        const now = Date.now();
        let changed = false;
        for (const r of Object.values(state.reminders)) {
            try {
                for (let step = 0; step < 4; step++) {
                    const at = nextAlert(r);
                    if (at == null) {
                        if (r.queuedFor && r.queuedFor > now) { await cancelSid(sidFor(r.id)).catch(() => { }); r.queuedFor = null; changed = true; }
                        break;
                    }
                    if (at <= now) {
                        // This alert's moment has come. ntfy already has it if it was handed over for this time.
                        // A missed alert is sent late if it's under 3 hours old; a missed nag (hourly/daily until done) always is,
                        // except during quiet hours, when it waits for the morning.
                        const nag = !!FOLLOW[r.follow] && !!r.lastNote;
                        const late = now - at > 2 * 60e3;
                        if (late && nag && !(r.followTime && r.follow !== "hourly") && quiet(now) !== now) { r.snooze = quiet(now); r.queuedFor = null; changed = true; continue; }
                        const send = now - at < LATE || nag;
                        if (r.queuedFor !== at && send && r.push !== false) await ntfy(reminderMessage(r, null));
                        if (send) await sendMailAlerts(r).catch((err) => note(`reminder mail for ${r.title}: ${err.message}`));
                        if (send) r.firedAt = new Date(now).toISOString();
                        r.lastNote = new Date(late && send ? now : at).toISOString();
                        if (r.snooze && r.snooze <= at) r.snooze = null;
                        // A repeating reminder with no nagging moves on to its next time.
                        if (r.repeat && r.repeat !== "none" && !FOLLOW[r.follow]) {
                            r.due = new Date(nextOccurrence(+new Date(r.due), r.repeat, now, settings().tz)).toISOString();
                            r.lastNote = null;
                        }
                        r.queuedFor = null;
                        changed = true;
                        continue;
                    }
                    if (at - now <= AHEAD) {
                        if (r.queuedFor !== at && r.push !== false) {
                            await ntfy(reminderMessage(r, at - now > 15e3 ? at : null));
                            r.queuedFor = at;
                            changed = true;
                        }
                    }
                    else if (r.queuedFor) { await cancelSid(sidFor(r.id)).catch(() => { }); r.queuedFor = null; changed = true; }
                    break;
                }
                r.error = null;
            }
            catch (err) {
                if (r.error !== err.message) { r.error = err.message; note(`${r.title}: ${err.message}`); changed = true; }
            }
        }
        if (changed) await save();
    }
    finally { ticking = false; }
}
async function sendMailAlerts(r) {
    const label = (r.priority === "urgent" ? "URGENT: " : r.priority === "high" ? "High priority: " : "") + r.title + (r.notes ? ` — ${String(r.notes).slice(0, 100)}` : "");
    const s = settings();
    for (const [kind, x] of [["text", r.text], ["email", r.email]]) {
        if (!x || !x.inbox || !x.to) continue;
        const { mail } = await openInbox(x.inbox, "send", "send reminder");
        await mail.send(kind === "text"
            ? { to: [x.to], subject: "Reminder", body: label.slice(0, 140) }
            : { to: [x.to], subject: `Reminder: ${label.slice(0, 80)}`, body: label + (s.click ? `\n\nOpen Organized Chaos: ${s.click}` : "") });
    }
}
export function startNotifier() {
    setTimeout(() => tick().catch(() => { }), 5000).unref();
    setInterval(() => tick().catch(() => { }), TICK).unref();
}

/* ---------- the settings page (token typed here, never in chat) ---------- */
const links = new Map();
export function ntfyForm(k, error) {
    const link = links.get(k);
    if (!link || link.expires < Date.now()) return page("This link expired", "<p>Start again from Organized Chaos › Settings › Phone notifications.</p>");
    const s = settings();
    return page("Connect ntfy notifications", `
<p>Organized Chaos sends reminders and alerts to your ntfy topic. For a private topic, make an <b>access token</b> in the ntfy app or at
<a href="https://ntfy.sh/account" target="_blank" rel="noopener">ntfy.sh › Account</a> › Access tokens, and paste it here.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/ntfy/connect">
<input type="hidden" name="k" value="${escapeHtml(k)}">
<label for="tp">Topic</label>
<input id="tp" type="text" name="topic" value="${escapeHtml(s.topic)}" required>
<label for="tk">Access token</label>
<input id="tk" type="password" name="token" autocomplete="off" placeholder="${s.token ? "Saved. Leave blank to keep it" : "tk_…"}">
<label for="sv">ntfy server <small>(leave as is unless you run your own)</small></label>
<input id="sv" type="text" name="server" value="${escapeHtml(s.server)}">
<button type="submit">Save and send a test</button>
<p><small>The token is kept encrypted on your mail server and only used to post to this topic.</small></p>
</form>`);
}
export async function finishNtfyForm(k, form) {
    const link = links.get(k);
    if (!link || link.expires < Date.now()) throw new Error("This link expired. Start again from Organized Chaos.");
    await load();
    const topic = String(form.topic ?? "").trim();
    const token = String(form.token ?? "").trim();
    const server = String(form.server ?? "").trim().replace(/\/+$/, "") || DEFAULT_SERVER;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) throw new Error("A topic is letters, numbers, - and _ only.");
    if (!/^https:\/\/[^\s/]+$/.test(server)) throw new Error("The server must be an https address, like https://ntfy.sh.");
    if (token && !/^tk_[A-Za-z0-9]{10,}$/.test(token)) throw new Error("An ntfy access token starts with tk_.");
    const before = { ...state.settings };
    state.settings.topic = topic;
    state.settings.server = server;
    if (token) state.settings.token = token;
    try {
        await ntfy({ title: "Organized Chaos is connected", message: "Reminders and alerts will arrive here.", tags: ["white_check_mark"] });
    }
    catch (err) {
        state.settings = before;
        throw err;
    }
    for (const r of Object.values(state.reminders)) r.queuedFor = null; // hand everything to the new topic
    links.delete(k);
    note(`connected to ${server}/${topic}`);
    await save();
    tick().catch(() => { });
}
/** Done / Snooze buttons on a notification. */
export async function ntfyAction(q) {
    const id = String(q.id ?? ""), a = String(q.a ?? ""), sig = String(q.s ?? "");
    if (!["done", "snooze"].includes(a)) throw new Error("unknown action");
    const want = Buffer.from(sign(id, a)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error("bad link");
    await load();
    const r = state.reminders[id];
    if (!r) return "That reminder is already gone.";
    if (a === "done") {
        r.done = true;
        r.doneFromPhone = new Date().toISOString();
        if (r.queuedFor) { await cancelSid(sidFor(id)).catch(() => { }); r.queuedFor = null; }
        note(`done from phone: ${r.title}`);
        await save();
        return `Done: ${r.title}`;
    }
    r.lastNote = new Date().toISOString();
    r.snooze = Date.now() + 3600e3;
    note(`snoozed: ${r.title}`);
    await save();
    tick().catch(() => { });
    return `Snoozed for an hour: ${r.title}`;
}

/* ---------- tools ---------- */
function publicState(r) {
    const at = nextAlert(r);
    return { id: r.id, due: r.due, lastNote: r.lastNote ?? null, next: at ? new Date(at).toISOString() : null, queued: !!r.queuedFor,
        done_from_phone: r.doneFromPhone ?? null, error: r.error ?? null };
}
const ReminderInput = z.object({
    id: z.string().max(80),
    title: z.string().max(300),
    notes: z.string().max(2000).optional(),
    client: z.string().max(80).optional(),
    priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
    due: z.string().describe("ISO time the task is due."),
    last_note: z.string().nullable().optional().describe("When the last alert went off, if known (ISO)."),
    follow: z.enum(["none", "hourly", "daily", "weekly"]).optional().describe("Keep alerting every hour, day or week until done."),
    follow_time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional().describe("For daily or weekly follow-ups: the time of day, HH:MM in the person's time zone."),
    follow_dow: z.number().int().min(0).max(6).nullable().optional().describe("For weekly follow-ups: the day of the week, 0 = Sunday."),
    repeat: z.string().optional().describe("none, daily, weekdays, weekly, biweekly, monthly or yearly."),
    push: z.boolean().optional(),
    email: z.object({ inbox: z.string(), to: z.string() }).nullable().optional().describe("Also email this address when it goes off."),
    text: z.object({ inbox: z.string(), to: z.string() }).nullable().optional().describe("Also text (email-to-SMS) this address."),
    sig: z.string().max(400).describe("Changes whenever the app changes the reminder's time or repeat settings."),
});
export function registerNotifyTools(server) {
    server.registerTool("notify_status", {
        title: "Phone notification settings",
        description: "Shows whether ntfy phone notifications are connected (server, topic, whether a token is saved), the reminders waiting, and recent problems.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, safe(async () => {
        await load();
        const s = settings();
        return ok({ server: s.server, topic: s.topic, has_token: !!s.token, time_zone: s.tz, quiet_hours: [s.quietStart, s.quietEnd],
            reminders: Object.values(state.reminders).map(publicState), recent: state.log.slice(0, 10) });
    }));
    server.registerTool("notify_setup", {
        title: "Connect ntfy phone notifications",
        description: "Returns a link to this server's own page where the person enters the ntfy topic and access token (never in chat). " +
            "Optionally sets the time zone, quiet hours and the link notifications open.",
        inputSchema: {
            time_zone: z.string().optional(),
            quiet_start: z.number().int().min(0).max(23).optional(),
            quiet_end: z.number().int().min(0).max(23).optional(),
            click_url: z.string().url().optional(),
        },
    }, safe(async ({ time_zone, quiet_start, quiet_end, click_url }) => {
        await load();
        if (time_zone) { parts(Date.now(), time_zone); state.settings.tz = time_zone; }
        if (quiet_start != null) state.settings.quietStart = quiet_start;
        if (quiet_end != null) state.settings.quietEnd = quiet_end;
        if (click_url) state.settings.click = click_url;
        await save();
        const k = randomBytes(24).toString("base64url");
        links.set(k, { expires: Date.now() + 30 * 60e3 });
        setTimeout(() => links.delete(k), 30 * 60e3).unref();
        return ok({ url: `${baseUrl()}/ntfy/connect?k=${k}`, note: "Open this link in a browser to enter the ntfy topic and access token. It works for 30 minutes." });
    }));
    server.registerTool("notify_send", {
        title: "Send a phone notification",
        description: "Push a notification to the person's phone through ntfy, now or at a set time (up to 3 days ahead). " +
            "Give a sequence_id to replace or later cancel it.",
        inputSchema: {
            title: z.string().max(250),
            message: z.string().max(3500).optional(),
            priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
            tags: z.array(z.string()).max(5).optional(),
            click: z.string().url().optional(),
            at: z.string().optional().describe("ISO time to deliver it; leave out to send now."),
            sequence_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
        },
        annotations: { openWorldHint: true },
    }, safe(async ({ title, message, priority, tags, click, at, sequence_id }) => {
        await load();
        const when = at ? +new Date(at) : 0;
        if (at && !(when > 0)) throw new Error("at must be an ISO time.");
        if (when && when - Date.now() > 3 * 24 * 3600e3) throw new Error("ntfy can only hold a message up to 3 days ahead.");
        const r = await ntfy({ title, message: message || title, priority: PRIO[priority] ?? 3, ...(tags ? { tags } : {}),
            ...(click || settings().click ? { click: click || settings().click } : {}),
            ...(sequence_id ? { sequence_id } : {}), ...(when && when - Date.now() > 15e3 ? { delay: String(Math.floor(when / 1000)) } : {}) });
        return ok({ sent: true, id: r.id ?? null, at: when ? new Date(when).toISOString() : "now" });
    }));
    server.registerTool("notify_cancel", {
        title: "Cancel a scheduled phone notification",
        description: "Cancel a notification sent with notify_send and a sequence_id, if it hasn't gone off yet (or remove it from the phone if it has).",
        inputSchema: { sequence_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) },
    }, safe(async ({ sequence_id }) => {
        await load();
        await cancelSid(sequence_id);
        return ok({ cancelled: sequence_id });
    }));
    server.registerTool("reminders_sync", {
        title: "Sync task reminders",
        description: "Organized Chaos sends the complete list of task alarms it wants. This server schedules each one through ntfy, " +
            "drops any not in the list, and returns each reminder's state (its due time after repeats, when it last went off, " +
            "and whether it was marked done from the phone).",
        inputSchema: {
            reminders: z.array(ReminderInput).max(500),
            time_zone: z.string().optional(),
            quiet_start: z.number().int().min(0).max(23).optional(),
            quiet_end: z.number().int().min(0).max(23).optional(),
            click_url: z.string().url().optional(),
        },
    }, safe(async ({ reminders, time_zone, quiet_start, quiet_end, click_url }) => {
        await load();
        if (time_zone) { parts(Date.now(), time_zone); state.settings.tz = time_zone; }
        if (quiet_start != null) state.settings.quietStart = quiet_start;
        if (quiet_end != null) state.settings.quietEnd = quiet_end;
        if (click_url) state.settings.click = click_url;
        const want = new Map(reminders.map((x) => [x.id, x]));
        for (const [id, r] of Object.entries(state.reminders)) {
            if (want.has(id)) continue;
            if (r.queuedFor && r.queuedFor > Date.now()) await cancelSid(sidFor(id)).catch(() => { });
            delete state.reminders[id];
        }
        for (const x of reminders) {
            const cur = state.reminders[x.id];
            const base = { title: x.title, notes: x.notes ?? "", client: x.client ?? "", priority: x.priority ?? "normal", push: x.push !== false,
                email: x.email ?? null, text: x.text ?? null };
            if (cur && cur.appSig === x.sig && !(cur.done && !cur.doneFromPhone)) { Object.assign(cur, base); continue; }
            if (!(+new Date(x.due) > 0)) continue;
            state.reminders[x.id] = { ...(cur ? { queuedFor: cur.queuedFor ?? null } : {}), id: x.id, ...base, due: new Date(x.due).toISOString(),
                lastNote: x.last_note ?? null, follow: x.follow ?? "none", followTime: x.follow_time ?? null, followDow: x.follow_dow ?? null, repeat: x.repeat ?? "none", appSig: x.sig, done: false, snooze: null };
        }
        await save();
        await tick();
        const s = settings();
        return ok({ topic: s.topic, has_token: !!s.token,
            reminders: Object.values(state.reminders).map(publicState) });
    }));
}
