/** Date and time helpers for calendars, using only the built-in Intl time zone data. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** The time zone of this computer, e.g. "America/New_York". */
export function localZone() {
    // On a cloud server the computer's zone is UTC, which isn't anyone's local time; use the owner's zone instead.
    if (process.env.OWNER_TIME_ZONE)
        return process.env.OWNER_TIME_ZONE;
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return !z || /^(Etc\/)?(UTC|GMT|Universal|Zulu)$/i.test(z) ? "America/New_York" : z;
}
export function checkZone(tz) {
    const zone = tz?.trim() || localZone();
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
    }
    catch {
        throw new Error(`"${zone}" isn't a time zone I know. Use a name like "America/Chicago".`);
    }
    return zone;
}
/** Minutes the zone is ahead of UTC at that moment. */
function offsetMinutes(ms, tz) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    })
        .formatToParts(new Date(ms))
        .map((p) => [p.type, p.value]));
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}
/** "2026-10-20T15:00" in a zone, or anything with its own offset, as a moment. */
export function toMs(input, tz) {
    const s = input.trim();
    if (HAS_OFFSET.test(s)) {
        const ms = Date.parse(s);
        if (Number.isNaN(ms))
            throw new Error(`"${input}" isn't a date and time I understand.`);
        return ms;
    }
    const m = s.match(LOCAL_TIME);
    if (!m) {
        throw new Error(`"${input}" isn't a date and time I understand. Use 2026-10-20T15:00.`);
    }
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
    // Guess with the offset at that wall time, then correct once for DST changes.
    let ms = wall - offsetMinutes(wall, tz) * 60_000;
    ms = wall - offsetMinutes(ms, tz) * 60_000;
    return ms;
}
/** A moment shown in a zone with its offset: "2026-10-20T15:00:00-04:00". */
export function formatInZone(ms, tz) {
    const off = offsetMinutes(ms, tz);
    const local = new Date(ms + off * 60_000).toISOString().slice(0, 19);
    const sign = off < 0 ? "-" : "+";
    const abs = Math.abs(off);
    return `${local}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
function pad(n) {
    return String(n).padStart(2, "0");
}
export function parseWhen(input, tz) {
    const s = input.trim();
    if (DATE_ONLY.test(s))
        return { allDay: true, date: s };
    return { allDay: false, ms: toMs(s, tz) };
}
export function addDays(date, days) {
    return new Date(Date.parse(date + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
}
/** Reads back an event's start/end as shown by the providers (see CalendarEvent). */
export function rangeOf(event) {
    return event.allDay
        ? { start: { allDay: true, date: event.start }, end: { allDay: true, date: event.end } }
        : {
            start: { allDay: false, ms: Date.parse(event.start) },
            end: { allDay: false, ms: Date.parse(event.end) },
        };
}
/**
 * Works out the new start and end. A missing end keeps the current length (or
 * one hour / one day for new events), so "move it to 3pm" just works.
 */
export function resolveRange(start, end, tz, current) {
    const s = start ? parseWhen(start, tz) : current?.start;
    if (!s)
        throw new Error("A start time is needed.");
    let e;
    if (end) {
        e = parseWhen(end, tz);
    }
    else if (start && current && current.start.allDay === s.allDay) {
        e = s.allDay
            ? {
                allDay: true,
                date: addDays(s.date, daysBetween(dateOf(current.start), dateOf(current.end))),
            }
            : { allDay: false, ms: s.ms + (msOf(current.end) - msOf(current.start)) };
    }
    else if (start || !current) {
        e = s.allDay ? { allDay: true, date: s.date } : { allDay: false, ms: s.ms + HOUR };
    }
    else {
        e = current.end;
    }
    if (s.allDay !== e.allDay) {
        throw new Error("Give the start and end both as dates (all-day) or both as times.");
    }
    if (s.allDay ? daysBetween(s.date, e.date) < 0 : msOf(e) <= s.ms) {
        throw new Error("The end has to be after the start.");
    }
    return { start: s, end: e };
}
function dateOf(w) {
    return w.date;
}
function msOf(w) {
    return w.ms;
}
//# sourceMappingURL=time.js.map
