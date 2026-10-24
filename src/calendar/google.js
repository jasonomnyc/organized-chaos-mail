import { randomUUID } from "node:crypto";
import { addDays, formatInZone } from "./time.js";
import { clip, LIST_DESCRIPTION_CHARS, MAX_DESCRIPTION_CHARS, people, } from "./types.js";
const API = (process.env.EMAIL_MCP_GCAL_API ?? "https://www.googleapis.com") + "/calendar/v3";
const RESPONSES = {
    accepted: "accepted",
    declined: "declined",
    tentative: "tentative",
    needsAction: "needs_reply",
};
export class GoogleCalendar {
    client;
    calendars;
    constructor(client) {
        this.client = client;
    }
    async call(path, opts = {}) {
        const url = new URL(API + path);
        for (const [k, v] of Object.entries(opts.params ?? {})) {
            if (v !== undefined)
                url.searchParams.set(k, String(v));
        }
        try {
            const res = await this.client.request({
                url: url.toString(),
                method: (opts.method ?? "GET"),
                data: opts.data,
            });
            return res.data;
        }
        catch (err) {
            throw readableError(err);
        }
    }
    async allCalendars() {
        if (!this.calendars) {
            const res = await this.call("/users/me/calendarList", {
                params: { maxResults: 250 },
            });
            this.calendars = res.items ?? [];
        }
        return this.calendars;
    }
    async calendarId(name) {
        const wanted = name?.trim();
        if (!wanted || wanted.toLowerCase() === "primary")
            return "primary";
        const lower = wanted.toLowerCase();
        const match = (await this.allCalendars()).find((c) => c.id === wanted ||
            (c.summaryOverride ?? c.summary).toLowerCase() === lower ||
            c.summary.toLowerCase() === lower);
        if (!match)
            throw new Error(`There's no calendar called "${wanted}" in this account.`);
        return match.primary ? "primary" : match.id;
    }
    async listCalendars() {
        return (await this.allCalendars()).map((c) => ({
            id: c.id,
            name: c.summaryOverride ?? c.summary,
            primary: !!c.primary,
            canEdit: c.accessRole === "owner" || c.accessRole === "writer",
        }));
    }
    async listEvents(q) {
        const cal = await this.calendarId(q.calendar);
        const res = await this.call(`/calendars/${enc(cal)}/events`, {
            params: {
                timeMin: new Date(q.startMs).toISOString(),
                timeMax: new Date(q.endMs).toISOString(),
                singleEvents: true,
                orderBy: "startTime",
                maxResults: q.maxResults,
                q: q.query || undefined,
                timeZone: q.timeZone,
            },
        });
        return (res.items ?? []).map((e) => toEvent(e, cal, q.timeZone, LIST_DESCRIPTION_CHARS));
    }
    raw(cal, id, timeZone) {
        return this.call(`/calendars/${enc(cal)}/events/${enc(id)}`, {
            params: { timeZone },
        });
    }
    async getEvent(calendar, id, timeZone) {
        const cal = await this.calendarId(calendar);
        return toEvent(await this.raw(cal, id, timeZone), cal, timeZone, MAX_DESCRIPTION_CHARS);
    }
    async createEvent(calendar, event) {
        const cal = await this.calendarId(calendar);
        const attendees = [
            ...people(event.attendees).map((a) => ({ email: a.email, displayName: a.name })),
            ...people(event.optionalAttendees).map((a) => ({
                email: a.email,
                displayName: a.name,
                optional: true,
            })),
        ];
        const created = await this.call(`/calendars/${enc(cal)}/events`, {
            method: "POST",
            params: { sendUpdates: "all", conferenceDataVersion: event.videoCall ? 1 : undefined },
            data: {
                summary: event.title,
                description: event.description,
                location: event.location,
                start: toGTime(event.range.start, event.timeZone, false),
                end: toGTime(event.range.end, event.timeZone, true),
                attendees: attendees.length ? attendees : undefined,
                recurrence: event.repeat ? [gRule(event.repeat, event.repeatDate)] : undefined,
                reminders: event.reminderMinutes !== undefined
                    ? { useDefault: false, overrides: [{ method: "popup", minutes: event.reminderMinutes }] }
                    : undefined,
                conferenceData: event.videoCall
                    ? {
                        createRequest: {
                            requestId: randomUUID(),
                            conferenceSolutionKey: { type: "hangoutsMeet" },
                        },
                    }
                    : undefined,
            },
        });
        return toEvent(created, cal, event.timeZone, MAX_DESCRIPTION_CHARS);
    }
    async updateEvent(calendar, id, changes) {
        const cal = await this.calendarId(calendar);
        const patch = {};
        if (changes.title !== undefined)
            patch.summary = changes.title;
        if (changes.description !== undefined)
            patch.description = changes.description;
        if (changes.location !== undefined)
            patch.location = changes.location;
        if (changes.range) {
            patch.start = toGTime(changes.range.start, changes.timeZone, false);
            patch.end = toGTime(changes.range.end, changes.timeZone, true);
        }
        if (changes.addAttendees?.length || changes.removeAttendees?.length) {
            const current = await this.raw(cal, id, changes.timeZone);
            const remove = new Set(people(changes.removeAttendees).map((a) => a.email.toLowerCase()));
            const list = (current.attendees ?? []).filter((a) => !remove.has(a.email.toLowerCase()));
            for (const a of people(changes.addAttendees)) {
                if (!list.some((x) => x.email.toLowerCase() === a.email.toLowerCase())) {
                    list.push({ email: a.email, displayName: a.name });
                }
            }
            patch.attendees = list;
        }
        const updated = await this.call(`/calendars/${enc(cal)}/events/${enc(id)}`, {
            method: "PATCH",
            params: { sendUpdates: "all" },
            data: patch,
        });
        return toEvent(updated, cal, changes.timeZone, MAX_DESCRIPTION_CHARS);
    }
    async respond(calendar, id, response, comment) {
        const cal = await this.calendarId(calendar);
        const event = await this.raw(cal, id, "UTC");
        if (event.organizer?.self)
            throw new Error("This is your own event, so there's no invite to answer.");
        const attendees = event.attendees ?? [];
        const me = attendees.find((a) => a.self);
        if (!me)
            throw new Error("This account isn't on the guest list for that event.");
        me.responseStatus = response;
        if (comment !== undefined)
            me.comment = comment;
        await this.call(`/calendars/${enc(cal)}/events/${enc(id)}`, {
            method: "PATCH",
            params: { sendUpdates: "all" },
            data: { attendees },
        });
    }
    async cancelEvent(calendar, id) {
        const cal = await this.calendarId(calendar);
        const event = await this.raw(cal, id, "UTC");
        const others = (event.attendees ?? []).some((a) => !a.self);
        const mine = !!event.organizer?.self || event.organizer?.email === cal;
        if (!mine && others) {
            throw new Error("Someone else organized this event, so it can't be cancelled for everyone. Decline it instead.");
        }
        await this.call(`/calendars/${enc(cal)}/events/${enc(id)}`, {
            method: "DELETE",
            params: { sendUpdates: "all" },
        });
    }
}
function enc(id) {
    return encodeURIComponent(id);
}
function toGTime(when, tz, isEnd) {
    if (when.allDay)
        return { date: isEnd ? addDays(when.date, 1) : when.date };
    return { dateTime: formatInZone(when.ms, tz), timeZone: tz };
}
function fromGTime(t, tz, isEnd) {
    if (t.date)
        return isEnd ? addDays(t.date, -1) : t.date;
    return formatInZone(Date.parse(t.dateTime ?? ""), tz);
}
function toEvent(e, calendarId, tz, maxDescription) {
    // Events made on a shared calendar list that calendar as the organizer.
    const isOrganizer = !!e.organizer?.self || (!!e.organizer?.email && e.organizer.email === calendarId);
    const attendees = (e.attendees ?? []).map((a) => ({
        ...(a.displayName ? { name: a.displayName } : {}),
        email: a.email,
        response: RESPONSES[a.responseStatus ?? "needsAction"] ?? "needs_reply",
        optional: !!a.optional,
        organizer: !!a.organizer,
        self: !!a.self,
    }));
    const mine = attendees.find((a) => a.self);
    return {
        id: e.id,
        calendarId,
        title: e.summary || "(no title)",
        start: fromGTime(e.start, tz, false),
        end: fromGTime(e.end, tz, true),
        allDay: !!e.start.date,
        location: e.location || undefined,
        description: clip(e.description, maxDescription),
        organizer: e.organizer?.email
            ? {
                ...(e.organizer.displayName ? { name: e.organizer.displayName } : {}),
                email: e.organizer.email,
            }
            : undefined,
        isOrganizer,
        myResponse: isOrganizer ? "organizer" : (mine?.response ?? "accepted"),
        attendees,
        seriesId: e.recurringEventId,
        cancelled: e.status === "cancelled",
        videoCallLink: e.hangoutLink,
        link: e.htmlLink,
    };
}
/** Turns Google's errors into something a person can act on. */
function readableError(err) {
    const e = err;
    const status = e.response?.status ?? e.status;
    const detail = e.response?.data?.error;
    const message = detail?.message ?? e.message ?? String(err);
    const reasons = (detail?.errors ?? []).map((x) => x.reason);
    if (reasons.includes("accessNotConfigured") || /has not been used|is disabled/i.test(message)) {
        return new Error("The Google Calendar API isn't turned on in the Google Cloud project yet. Turn it on " +
            "(step 1b of the setup guide), wait a minute, and try again.");
    }
    if (status === 403 &&
        (reasons.includes("insufficientPermissions") || /insufficient/i.test(message))) {
        return new Error("This Google account hasn't allowed calendar access. Remove it and add it back, and tick " +
            "the calendar box when Google asks.");
    }
    if (status === 404)
        return new Error("That event or calendar wasn't found.");
    return new Error(`Google returned an error${status ? ` (${status})` : ""}: ${message}`);
}
//# sourceMappingURL=google.js.map

const G_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/** An RRULE for one of the simple repeat choices. */
function gRule(repeat, start) {
    const d = start ? new Date(`${start}T12:00:00Z`) : null;
    const day = d && !isNaN(d) ? G_DAYS[d.getUTCDay()] : null;
    switch (repeat) {
        case "daily": return "RRULE:FREQ=DAILY";
        case "weekdays": return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
        case "weekly": return "RRULE:FREQ=WEEKLY" + (day ? `;BYDAY=${day}` : "");
        case "biweekly": return "RRULE:FREQ=WEEKLY;INTERVAL=2" + (day ? `;BYDAY=${day}` : "");
        case "monthly": return "RRULE:FREQ=MONTHLY";
        default: return "RRULE:FREQ=YEARLY";
    }
}
