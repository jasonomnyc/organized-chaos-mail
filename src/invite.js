import { randomUUID } from "node:crypto";
import { z } from "zod";
import { findAccount, loadConfig, requirePermission } from "./config.js";
import { calendarFor, providerFor } from "./providers/index.js";
import { formatInZone, toMs } from "./calendar/time.js";
import { inbox, ok, safe } from "./tools.js";

/**
 * Meeting invites that arrive as an .ics file on an email.
 * get_invite reads the file and says whether the meeting is already on that inbox's calendar.
 * respond_to_invite answers it: if the meeting is on the calendar it's answered there (the organizer is told
 * the normal way); if not, accepting adds it to the calendar and the answer goes back to the organizer by email.
 */

// ---------- reading .ics files ----------
const WINDOWS_ZONES = {
    "eastern standard time": "America/New_York", "us eastern standard time": "America/Indianapolis",
    "central standard time": "America/Chicago", "mountain standard time": "America/Denver",
    "us mountain standard time": "America/Phoenix", "pacific standard time": "America/Los_Angeles",
    "alaskan standard time": "America/Anchorage", "hawaiian standard time": "Pacific/Honolulu",
    "atlantic standard time": "America/Halifax", "gmt standard time": "Europe/London",
    "greenwich standard time": "Atlantic/Reykjavik", "w. europe standard time": "Europe/Berlin",
    "romance standard time": "Europe/Paris", "central europe standard time": "Europe/Budapest",
    "central european standard time": "Europe/Warsaw", "e. europe standard time": "Europe/Chisinau",
    "fle standard time": "Europe/Kiev", "gtb standard time": "Europe/Bucharest",
    "south africa standard time": "Africa/Johannesburg", "israel standard time": "Asia/Jerusalem",
    "india standard time": "Asia/Kolkata", "china standard time": "Asia/Shanghai",
    "tokyo standard time": "Asia/Tokyo", "aus eastern standard time": "Australia/Sydney",
    "utc": "UTC", "coordinated universal time": "UTC",
};
function zoneName(tzid) {
    if (!tzid) return undefined;
    const t = tzid.replace(/^"|"$/g, "").trim();
    try { new Intl.DateTimeFormat("en-US", { timeZone: t }); return t; } catch { /* not IANA */ }
    return WINDOWS_ZONES[t.toLowerCase()];
}
function unescapeText(v) {
    return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}
function parseLine(line) {
    // NAME;P1=V1;P2="V 2":VALUE — the first colon outside quotes ends the parameters.
    let i = 0, q = false;
    for (; i < line.length; i++) {
        const c = line[i];
        if (c === '"') q = !q;
        else if (c === ":" && !q) break;
    }
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...ps] = head.match(/(?:"[^"]*"|[^;])+/g) ?? [head];
    const params = {};
    for (const p of ps) {
        const j = p.indexOf("=");
        if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, "");
    }
    return { name: name.toUpperCase(), params, value, raw: line };
}
function mailto(v) {
    return String(v || "").replace(/^mailto:/i, "").trim();
}
/** A DTSTART/DTEND line as { allDay, date } or { allDay:false, ms, zone }. */
function when(prop, fallbackZone) {
    if (!prop) return undefined;
    const v = prop.value.trim();
    if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
        return { allDay: true, date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
    }
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
    if (!m) return undefined;
    const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}`;
    if (m[7]) return { allDay: false, ms: Date.parse(local + "Z"), zone: "UTC" };
    const zone = zoneName(prop.params.TZID) ?? fallbackZone;
    return { allDay: false, ms: toMs(local, zone), zone };
}
export function parseIcs(text, fallbackZone) {
    const lines = String(text).replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean);
    let method = "PUBLISH";
    const events = [], timezones = [];
    let cur = null, depth = [], tzBuf = null;
    for (const line of lines) {
        const p = parseLine(line);
        if (p.name === "BEGIN") {
            depth.push(p.value.toUpperCase());
            if (p.value.toUpperCase() === "VEVENT" && depth.length === 2) cur = { props: {}, multi: {} };
            if (p.value.toUpperCase() === "VTIMEZONE") tzBuf = [line];
            else if (tzBuf) tzBuf.push(line);
            continue;
        }
        if (p.name === "END") {
            const what = depth.pop();
            if (tzBuf) { tzBuf.push(line); if (what === "VTIMEZONE") { timezones.push(tzBuf.join("\r\n")); tzBuf = null; } }
            if (what === "VEVENT" && cur && depth.length === 1) { events.push(cur); cur = null; }
            continue;
        }
        if (tzBuf) { tzBuf.push(line); continue; }
        if (depth.length === 1 && p.name === "METHOD") method = p.value.trim().toUpperCase();
        if (cur && depth.length === 2) {
            if (["ATTENDEE", "RRULE", "EXDATE", "RDATE"].includes(p.name)) (cur.multi[p.name] ||= []).push(p);
            else if (!cur.props[p.name]) cur.props[p.name] = p;
        }
    }
    if (!events.length) return null;
    // The series (or single meeting) itself, not one changed occurrence.
    const ev = events.find((e) => !e.props["RECURRENCE-ID"]) ?? events[0];
    const P = ev.props;
    const start = when(P.DTSTART, fallbackZone);
    let end = when(P.DTEND, fallbackZone);
    if (!end && start && P.DURATION) {
        const d = P.DURATION.value.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
        const ms = d ? (((+d[1] || 0) * 7 + (+d[2] || 0)) * 86400 + (+d[3] || 0) * 3600 + (+d[4] || 0) * 60 + (+d[5] || 0)) * 1000 : 0;
        end = start.allDay ? start : { ...start, ms: start.ms + ms };
    }
    if (!end && start) end = start.allDay ? start : { ...start, ms: start.ms + 3600_000 };
    const organizer = P.ORGANIZER ? { email: mailto(P.ORGANIZER.value), ...(P.ORGANIZER.params.CN ? { name: P.ORGANIZER.params.CN } : {}) } : undefined;
    const attendees = (ev.multi.ATTENDEE ?? []).map((a) => ({
        email: mailto(a.value),
        ...(a.params.CN ? { name: a.params.CN } : {}),
        status: (a.params.PARTSTAT || "NEEDS-ACTION").toUpperCase(),
    }));
    return {
        method,
        uid: P.UID?.value.trim(),
        sequence: P.SEQUENCE ? +P.SEQUENCE.value || 0 : 0,
        title: P.SUMMARY ? unescapeText(P.SUMMARY.value) : "(no title)",
        location: P.LOCATION ? unescapeText(P.LOCATION.value) : undefined,
        description: P.DESCRIPTION ? unescapeText(P.DESCRIPTION.value) : undefined,
        start, end,
        rrule: (ev.multi.RRULE ?? []).map((r) => "RRULE:" + r.value),
        exdates: (ev.multi.EXDATE ?? []).map((r) => r.raw),
        organizer, attendees,
        status: P.STATUS?.value.toUpperCase(),
        raw: { DTSTART: P.DTSTART?.raw, DTEND: P.DTEND?.raw, ORGANIZER: P.ORGANIZER?.raw, RECURRENCE_ID: P["RECURRENCE-ID"]?.raw },
        timezones,
    };
}

// ---------- finding the .ics on an email ----------
function isIcs(a) {
    return /\.ics$/i.test(a.filename || "") || /^(text\/calendar|application\/ics)/i.test(a.mimeType || "");
}
async function readInvite(config, account, emailId) {
    const mail = await providerFor(config, account);
    const email = await mail.getEmail(emailId);
    const files = (email.attachments ?? []).filter(isIcs);
    if (!files.length && account.provider !== "gmail") {
        // Outlook turns meeting invites into calendar items rather than .ics files.
        try {
            const m = await mail.call(`/messages/${encodeURIComponent(emailId)}`, {
                params: { $select: "id,subject", $expand: "microsoft.graph.eventMessage/event($select=id,seriesMasterId)" },
            });
            const ev = m?.event;
            if (ev) {
                const cal = await calendarFor(config, account);
                return { email, outlookEvent: await cal.getEvent(undefined, ev.seriesMasterId || ev.id, "UTC") };
            }
        } catch { /* not a meeting message */ }
    }
    if (!files.length) throw new Error("This email doesn't have a calendar invite attached.");
    let lastErr;
    for (const f of files) {
        try {
            const file = await mail.getAttachment(emailId, { id: f.id, filename: f.filename });
            const inv = parseIcs(file.data.toString("utf8"), process.env.TZ || "America/New_York");
            if (inv && inv.uid && inv.start) return { email, invite: inv };
        } catch (err) { lastErr = err; }
    }
    throw lastErr ?? new Error("The invite attached to this email couldn't be read.");
}

const norm = (s) => String(s || "").toLowerCase().replace(/^(updated invitation|invitation|invite)\s*:\s*/i, "").replace(/\s+/g, " ").trim();

/** The meeting on this account's calendar, if it's there. */
async function findOnCalendar(cal, account, inv) {
    // Google can look it up by the invite's own id.
    if (typeof cal.call === "function" && account.provider === "gmail") {
        try {
            const res = await cal.call(`/calendars/primary/events`, { params: { iCalUID: inv.uid, showDeleted: false } });
            const hit = (res.items ?? []).find((e) => e.status !== "cancelled");
            if (hit) return await cal.getEvent(undefined, hit.id, "UTC");
        } catch { /* fall through to the time search */ }
    }
    if (account.provider !== "gmail") {
        try {
            const safeUid = inv.uid.replace(/'/g, "''");
            const res = await cal.call(`/events`, { params: { $filter: `iCalUId eq '${safeUid}'`, $top: 5, $select: "id,seriesMasterId,isCancelled" } });
            const hit = (res.value ?? []).find((e) => !e.isCancelled);
            if (hit) return await cal.getEvent(undefined, hit.seriesMasterId || hit.id, "UTC");
        } catch { /* fall through */ }
    }
    // Otherwise, the same title at the same start time.
    const startMs = inv.start.allDay ? toMs(`${inv.start.date}T00:00`, "UTC") - 14 * 3600_000 : inv.start.ms - 60_000;
    const endMs = inv.start.allDay ? startMs + 38 * 3600_000 : inv.start.ms + 60_000;
    const list = await cal.listEvents({ startMs, endMs, maxResults: 50, timeZone: "UTC" });
    const want = norm(inv.title);
    const hit = list.find((e) => !e.cancelled && (norm(e.title) === want || norm(e.title).includes(want) || want.includes(norm(e.title))));
    return hit ?? null;
}

function describe(inv, zone) {
    const fmt = (w) => !w ? undefined : w.allDay ? w.date : formatInZone(w.ms, zone);
    return {
        title: inv.title,
        start: fmt(inv.start),
        end: fmt(inv.end),
        all_day: !!inv.start?.allDay,
        repeats: inv.rrule.length > 0,
        location: inv.location,
        organizer: inv.organizer,
        attendees: inv.attendees.map((a) => ({ email: a.email, ...(a.name ? { name: a.name } : {}), response: a.status.toLowerCase() })),
    };
}

// ---------- answering ----------
const PARTSTAT = { accept: "ACCEPTED", tentative: "TENTATIVE", decline: "DECLINED" };
const WORD = { accept: "Accepted", tentative: "Tentative", decline: "Declined" };
function icsText(v) {
    return String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function fold(line) {
    const out = [];
    let s = line;
    while (Buffer.byteLength(s) > 74) { out.push(s.slice(0, 73)); s = " " + s.slice(73); }
    out.push(s);
    return out.join("\r\n");
}
function stamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function replyIcs(inv, me, myName, response, note) {
    const lines = [
        "BEGIN:VCALENDAR", "PRODID:-//Organized Chaos//Mail//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:REPLY",
        ...inv.timezones.flatMap((t) => t.split("\r\n")),
        "BEGIN:VEVENT",
        `UID:${inv.uid}`,
        `DTSTAMP:${stamp(Date.now())}`,
        `SEQUENCE:${inv.sequence}`,
        inv.raw.RECURRENCE_ID,
        inv.raw.DTSTART,
        inv.raw.DTEND,
        `SUMMARY:${icsText(inv.title)}`,
        inv.raw.ORGANIZER,
        `ATTENDEE;PARTSTAT=${PARTSTAT[response]}${myName ? `;CN="${String(myName).replace(/"/g, "")}"` : ""}:mailto:${me}`,
        note ? `COMMENT:${icsText(note)}` : undefined,
        "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean);
    return lines.map(fold).join("\r\n") + "\r\n";
}

/** Puts the meeting on the calendar without emailing anyone (the answer goes by email separately). */
async function addToCalendar(cal, account, inv, response, myAddress) {
    const status = response === "accept" ? "accepted" : "tentative";
    if (account.provider === "gmail") {
        const t = (w, isEnd) => w.allDay
            ? { date: isEnd && inv.end === inv.start ? nextDay(w.date) : w.date }
            : { dateTime: new Date(w.ms).toISOString(), timeZone: w.zone === "UTC" ? "UTC" : w.zone };
        const attendees = inv.attendees.map((a) => ({
            email: a.email,
            ...(a.name ? { displayName: a.name } : {}),
            responseStatus: a.email.toLowerCase() === myAddress.toLowerCase() ? status
                : a.status === "ACCEPTED" ? "accepted" : a.status === "DECLINED" ? "declined" : a.status === "TENTATIVE" ? "tentative" : "needsAction",
        }));
        if (!attendees.some((a) => a.email.toLowerCase() === myAddress.toLowerCase())) attendees.push({ email: myAddress, responseStatus: status });
        const body = {
            iCalUID: inv.uid,
            sequence: inv.sequence,
            summary: inv.title,
            description: inv.description,
            location: inv.location,
            start: t(inv.start, false),
            end: t(inv.end, true),
            organizer: inv.organizer ? { email: inv.organizer.email, ...(inv.organizer.name ? { displayName: inv.organizer.name } : {}) } : undefined,
            attendees,
            recurrence: inv.rrule.length ? [...inv.rrule, ...inv.exdates] : undefined,
        };
        const made = await cal.call(`/calendars/primary/events/import`, { method: "POST", data: body });
        return { id: made.id, repeats_added: inv.rrule.length > 0 };
    }
    // Microsoft: a plain event with no guests, so Outlook doesn't send anything itself.
    const g = (w, isEnd) => w.allDay
        ? { dateTime: `${isEnd && inv.end === inv.start ? nextDay(w.date) : w.date}T00:00:00`, timeZone: "UTC" }
        : { dateTime: new Date(w.ms).toISOString().slice(0, 19), timeZone: "UTC" };
    const made = await cal.call(`/events`, {
        method: "POST",
        body: {
            subject: inv.title,
            body: { contentType: "Text", content: [inv.organizer ? `Organizer: ${inv.organizer.name ?? ""} <${inv.organizer.email}>` : "", inv.description ?? ""].filter(Boolean).join("\n\n") },
            start: g(inv.start, false),
            end: g(inv.end, true),
            isAllDay: !!inv.start.allDay,
            location: inv.location ? { displayName: inv.location } : undefined,
            showAs: response === "tentative" ? "tentative" : "busy",
            transactionId: randomUUID(),
        },
    });
    return { id: made.id, repeats_added: false };
}
function nextDay(date) {
    const d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

export function registerInviteTools(server) {
    server.registerTool("get_invite", {
        title: "Read a meeting invite on an email",
        description: "Read the calendar invite (.ics) attached to an email: the meeting, who sent it, and whether it's " +
            "already on that inbox's calendar and how it was answered.",
        inputSchema: { inbox, email_id: z.string(), time_zone: z.string().optional() },
        annotations: { readOnlyHint: true },
    }, safe(async ({ inbox: nick, email_id, time_zone }) => {
        const config = await loadConfig();
        const account = findAccount(config, nick);
        requirePermission(config, account, "read", "read invites");
        const zone = time_zone || "America/New_York";
        const { invite, outlookEvent: oe } = await readInvite(config, account, email_id);
        if (oe) {
            const fmt = (v) => (typeof v === "string" ? v : v?.dateTime ?? v?.date);
            return ok({
                inbox: account.nickname, kind: oe.cancelled ? "cancelled" : "invite",
                can_answer: !oe.isOrganizer && !oe.cancelled, is_organizer: !!oe.isOrganizer,
                on_calendar: true, event_id: oe.id, my_response: oe.myResponse,
                title: oe.title, start: fmt(oe.start), end: fmt(oe.end), all_day: !!oe.allDay, repeats: !!oe.seriesId || undefined,
                location: oe.location, organizer: oe.organizer, attendees: oe.attendees,
            });
        }
        const kind = invite.method === "REQUEST" || invite.method === "PUBLISH" ? (invite.method === "PUBLISH" ? "event" : "invite")
            : invite.method === "CANCEL" ? "cancelled" : invite.method === "REPLY" ? "reply" : invite.method.toLowerCase();
        const me = account.email.toLowerCase();
        const iAmOrganizer = invite.organizer?.email.toLowerCase() === me;
        let onCal = null;
        try { onCal = await findOnCalendar(await calendarFor(config, account), account, invite); } catch { /* calendar not reachable */ }
        const mine = invite.attendees.find((a) => a.email.toLowerCase() === me);
        return ok({
            inbox: account.nickname,
            kind,
            can_answer: kind === "invite" && !iAmOrganizer,
            is_organizer: iAmOrganizer,
            on_calendar: !!onCal,
            event_id: onCal ? (invite.rrule.length && onCal.seriesId ? onCal.seriesId : onCal.id) : undefined,
            my_response: onCal ? onCal.myResponse : mine ? mine.status.toLowerCase().replace("needs-action", "needs_reply") : "needs_reply",
            ...describe(invite, zone),
        });
    }));

    server.registerTool("respond_to_invite", {
        title: "Accept or decline an invite attached to an email",
        description: "Answer the calendar invite (.ics) attached to an email. If the meeting is already on this " +
            "inbox's calendar it's answered there. If not, accept or maybe adds it to the calendar, and the answer " +
            "is emailed to the organizer. The organizer is told either way. Confirm with the person first.",
        inputSchema: {
            inbox,
            email_id: z.string(),
            response: z.enum(["accept", "decline", "tentative"]),
            note: z.string().optional().describe("A short message to the organizer."),
        },
        annotations: { openWorldHint: true },
    }, safe(async ({ inbox: nick, email_id, response, note }) => {
        const config = await loadConfig();
        const account = findAccount(config, nick);
        requirePermission(config, account, "send", "answer invitations");
        const { invite, outlookEvent: oe } = await readInvite(config, account, email_id);
        const answer = response === "accept" ? "accepted" : response === "decline" ? "declined" : "tentative";
        if (oe) {
            if (oe.isOrganizer) throw new Error("This is your own meeting.");
            await (await calendarFor(config, account)).respond(undefined, oe.id, answer, note);
            return ok({ answered: answer, on_calendar: response !== "decline", how: "calendar", event_id: oe.id,
                message: `${WORD[response]} from "${account.nickname}".` });
        }
        if (invite.method === "CANCEL") throw new Error("This email cancels the meeting, so there's nothing to answer.");
        if (invite.method === "REPLY") throw new Error("This is someone's answer to your meeting, so there's nothing to answer.");
        const me = account.email;
        if (invite.organizer?.email.toLowerCase() === me.toLowerCase()) throw new Error("This is your own meeting.");
        const cal = await calendarFor(config, account);
        const onCal = await findOnCalendar(cal, account, invite).catch(() => null);
        if (onCal && !onCal.isOrganizer) {
            const id = invite.rrule.length && onCal.seriesId ? onCal.seriesId : onCal.id;
            try {
                await cal.respond(undefined, id, answer, note);
                return ok({ answered: answer, on_calendar: true, how: "calendar", event_id: id,
                    message: `${WORD[response]} from "${account.nickname}". ${response === "decline" ? "" : "It's on that calendar."}`.trim() });
            } catch (err) {
                // e.g. the account isn't on the guest list (invite sent to a group address): answer by email instead.
                if (!/guest list|isn't on/i.test(String(err?.message))) throw err;
            }
        }
        let added = null;
        if (response !== "decline" && !onCal) added = await addToCalendar(cal, account, invite, response, me);
        if (!invite.organizer?.email) {
            return ok({ answered: answer, on_calendar: !!added || !!onCal, how: "calendar_only", event_id: added?.id,
                message: "Added to your calendar. The invite has no organizer address, so no answer was sent." });
        }
        const mail = await providerFor(config, account);
        const name = process.env.OWNER_NAME || undefined;
        const ics = replyIcs(invite, me, name, response, note);
        await mail.send({
            to: [invite.organizer.name ? `${invite.organizer.name} <${invite.organizer.email}>` : invite.organizer.email],
            subject: `${WORD[response]}: ${invite.title}`,
            body: `${name || me} ${response === "accept" ? "accepted" : response === "decline" ? "declined" : "tentatively accepted"} this invitation.` + (note ? `\n\n${note}` : ""),
            attachments: [{ filename: "invite.ics", mimeType: "text/calendar; method=REPLY; charset=UTF-8", data: Buffer.from(ics, "utf8") }],
        });
        return ok({
            answered: answer,
            on_calendar: !!added || (!!onCal && response !== "decline"),
            how: "email",
            event_id: added?.id ?? onCal?.id,
            message: `${WORD[response]}. ${invite.organizer.email} was told by email` +
                (added ? `, and it's on your "${account.nickname}" calendar${invite.rrule.length && !added.repeats_added ? " (first meeting only; Outlook can't copy the repeat)" : ""}.` : "."),
        });
    }));
}
