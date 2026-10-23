import { GraphError, graphRequest } from "../providers/outlook.js";
import { addDays, formatInZone } from "./time.js";
import { clip, LIST_DESCRIPTION_CHARS, MAX_DESCRIPTION_CHARS, people, } from "./types.js";
const LIST_FIELDS = [
    "id",
    "subject",
    "bodyPreview",
    "start",
    "end",
    "isAllDay",
    "location",
    "organizer",
    "attendees",
    "isOrganizer",
    "responseStatus",
    "seriesMasterId",
    "isCancelled",
    "onlineMeeting",
    "webLink",
].join(",");
const FULL_FIELDS = LIST_FIELDS + ",body";
const RESPONSES = {
    accepted: "accepted",
    declined: "declined",
    tentativelyAccepted: "tentative",
    none: "needs_reply",
    notResponded: "needs_reply",
};
const ACTIONS = { accepted: "accept", declined: "decline", tentative: "tentativelyAccept" };
/** Times are always exchanged in UTC and shown in the person's own zone. */
const UTC = ['outlook.timezone="UTC"'];
export class OutlookCalendar {
    getToken;
    ownAddress;
    calendars;
    constructor(getToken, ownAddress) {
        this.getToken = getToken;
        this.ownAddress = ownAddress;
    }
    async call(path, opts = {}) {
        try {
            return await graphRequest(this.getToken, path, { ...opts, prefer: UTC });
        }
        catch (err) {
            if (err instanceof GraphError && err.status === 403) {
                throw new Error("This Microsoft account hasn't allowed calendar access. Remove it and add it back, " +
                    "and accept the calendar permission when Microsoft asks.");
            }
            if (err instanceof GraphError && err.status === 404) {
                throw new Error("That event or calendar wasn't found.");
            }
            throw err;
        }
    }
    async allCalendars() {
        if (!this.calendars) {
            const res = await this.call("/calendars", {
                params: { $top: 100, $select: "id,name,isDefaultCalendar,canEdit" },
            });
            this.calendars = res.value;
        }
        return this.calendars;
    }
    /** The Graph path for a calendar; the default calendar when none is named. */
    async base(name) {
        const wanted = name?.trim();
        if (!wanted || ["primary", "calendar", "default"].includes(wanted.toLowerCase())) {
            return { path: "/calendar", id: "primary" };
        }
        const lower = wanted.toLowerCase();
        const match = (await this.allCalendars()).find((c) => c.id === wanted || c.name.toLowerCase() === lower);
        if (!match)
            throw new Error(`There's no calendar called "${wanted}" in this account.`);
        if (match.isDefaultCalendar)
            return { path: "/calendar", id: "primary" };
        return { path: `/calendars/${enc(match.id)}`, id: match.id };
    }
    async listCalendars() {
        return (await this.allCalendars()).map((c) => ({
            id: c.id,
            name: c.name,
            primary: !!c.isDefaultCalendar,
            canEdit: c.canEdit !== false,
        }));
    }
    async listEvents(q) {
        const { path, id } = await this.base(q.calendar);
        // calendarView has no text search, so a query is matched here on a larger page.
        const res = await this.call(`${path}/calendarView`, {
            params: {
                startDateTime: new Date(q.startMs).toISOString(),
                endDateTime: new Date(q.endMs).toISOString(),
                $orderby: "start/dateTime",
                $top: q.query ? Math.min(q.maxResults * 4, 250) : q.maxResults,
                $select: LIST_FIELDS,
            },
        });
        let events = res.value;
        if (q.query) {
            const words = q.query.toLowerCase().split(/\s+/).filter(Boolean);
            events = events.filter((e) => {
                const text = [
                    e.subject,
                    e.location?.displayName,
                    e.bodyPreview,
                    e.organizer?.emailAddress.name,
                    e.organizer?.emailAddress.address,
                ]
                    .join(" ")
                    .toLowerCase();
                return words.every((w) => text.includes(w));
            });
        }
        return events
            .slice(0, q.maxResults)
            .map((e) => this.toEvent(e, id, q.timeZone, LIST_DESCRIPTION_CHARS));
    }
    raw(id) {
        return this.call(`/events/${enc(id)}`, { params: { $select: FULL_FIELDS } });
    }
    async getEvent(calendar, id, timeZone) {
        const { id: calId } = await this.base(calendar);
        return this.toEvent(await this.raw(id), calId, timeZone, MAX_DESCRIPTION_CHARS);
    }
    async createEvent(calendar, event) {
        const { path, id } = await this.base(calendar);
        const attendees = [
            ...people(event.attendees).map((a) => attendee(a, "required")),
            ...people(event.optionalAttendees).map((a) => attendee(a, "optional")),
        ];
        const created = await this.call(`${path}/events`, {
            method: "POST",
            body: {
                subject: event.title,
                body: { contentType: "Text", content: event.description ?? "" },
                start: toGraphTime(event.range.start, false),
                end: toGraphTime(event.range.end, true),
                isAllDay: event.range.start.allDay,
                location: event.location ? { displayName: event.location } : undefined,
                attendees,
                ...(event.videoCall ? { isOnlineMeeting: true } : {}),
            },
        });
        return this.toEvent(created, id, event.timeZone, MAX_DESCRIPTION_CHARS);
    }
    async updateEvent(calendar, id, changes) {
        const { id: calId } = await this.base(calendar);
        const patch = {};
        if (changes.title !== undefined)
            patch.subject = changes.title;
        if (changes.description !== undefined) {
            patch.body = { contentType: "Text", content: changes.description };
        }
        if (changes.location !== undefined)
            patch.location = { displayName: changes.location };
        if (changes.range) {
            patch.start = toGraphTime(changes.range.start, false);
            patch.end = toGraphTime(changes.range.end, true);
            patch.isAllDay = changes.range.start.allDay;
        }
        if (changes.addAttendees?.length || changes.removeAttendees?.length) {
            const current = await this.raw(id);
            const remove = new Set(people(changes.removeAttendees).map((a) => a.email.toLowerCase()));
            const list = (current.attendees ?? []).filter((a) => !remove.has(a.emailAddress.address.toLowerCase()));
            for (const a of people(changes.addAttendees)) {
                const email = a.email.toLowerCase();
                if (!list.some((x) => x.emailAddress.address.toLowerCase() === email)) {
                    list.push(attendee(a, "required"));
                }
            }
            patch.attendees = list.map(({ emailAddress, type }) => ({ emailAddress, type }));
        }
        const updated = await this.call(`/events/${enc(id)}`, {
            method: "PATCH",
            body: patch,
        });
        return this.toEvent(updated, calId, changes.timeZone, MAX_DESCRIPTION_CHARS);
    }
    async respond(_calendar, id, response, comment) {
        const event = await this.raw(id);
        if (event.isOrganizer)
            throw new Error("This is your own event, so there's no invite to answer.");
        await this.call(`/events/${enc(id)}/${ACTIONS[response]}`, {
            method: "POST",
            body: { comment: comment ?? "", sendResponse: true },
        });
    }
    async cancelEvent(_calendar, id, comment) {
        const event = await this.raw(id);
        if (!event.isOrganizer) {
            throw new Error("Someone else organized this event, so it can't be cancelled for everyone. Decline it instead.");
        }
        const others = (event.attendees ?? []).some((a) => !this.isMe(a.emailAddress.address));
        if (others) {
            await this.call(`/events/${enc(id)}/cancel`, {
                method: "POST",
                body: { comment: comment ?? "" },
            });
        }
        else {
            await this.call(`/events/${enc(id)}`, { method: "DELETE" });
        }
    }
    isMe(email) {
        return !!email && email.toLowerCase() === this.ownAddress.toLowerCase();
    }
    toEvent(e, calendarId, tz, maxDescription) {
        const allDay = !!e.isAllDay;
        const organizerEmail = e.organizer?.emailAddress.address;
        const attendees = (e.attendees ?? [])
            .filter((a) => a.type !== "resource")
            .map((a) => ({
            ...addr(a),
            response: RESPONSES[a.status?.response ?? "none"] ?? "needs_reply",
            optional: a.type === "optional",
            organizer: !!organizerEmail && a.emailAddress.address.toLowerCase() === organizerEmail.toLowerCase(),
            self: this.isMe(a.emailAddress.address),
        }));
        const mine = e.responseStatus?.response;
        return {
            id: e.id,
            calendarId,
            title: e.subject || "(no title)",
            start: fromGraphTime(e.start, allDay, tz, false),
            end: fromGraphTime(e.end, allDay, tz, true),
            allDay,
            location: e.location?.displayName || undefined,
            description: clip(e.body?.content ?? e.bodyPreview, maxDescription),
            organizer: e.organizer ? addr(e.organizer) : undefined,
            isOrganizer: !!e.isOrganizer,
            myResponse: e.isOrganizer || mine === "organizer"
                ? "organizer"
                : (RESPONSES[mine ?? "none"] ?? "needs_reply"),
            attendees,
            seriesId: e.seriesMasterId ?? undefined,
            cancelled: !!e.isCancelled,
            videoCallLink: e.onlineMeeting?.joinUrl ?? undefined,
            link: e.webLink,
        };
    }
}
function enc(id) {
    return encodeURIComponent(id);
}
function addr(r) {
    const { name, address } = r.emailAddress;
    return name && name !== address ? { name, email: address } : { email: address };
}
function attendee(a, type) {
    return { emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) }, type };
}
function toGraphTime(when, isEnd) {
    if (when.allDay) {
        return { dateTime: `${isEnd ? addDays(when.date, 1) : when.date}T00:00:00`, timeZone: "UTC" };
    }
    return { dateTime: new Date(when.ms).toISOString().slice(0, 19), timeZone: "UTC" };
}
function fromGraphTime(t, allDay, tz, isEnd) {
    const date = t.dateTime.slice(0, 10);
    if (allDay)
        return isEnd ? addDays(date, -1) : date;
    return formatInZone(Date.parse(t.dateTime.slice(0, 19) + "Z"), tz);
}
//# sourceMappingURL=outlook.js.map