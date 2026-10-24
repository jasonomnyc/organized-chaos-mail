import { z } from "zod";
import { findAccount, loadConfig, requirePermission, } from "./config.js";
import { calendarFor } from "./providers/index.js";
import { addDays, checkZone, formatInZone, parseWhen, rangeOf, resolveRange, toMs } from "./calendar/time.js";
import { othersOn } from "./calendar/types.js";
import { inbox, ok, safe } from "./tools.js";
const WEEK = 7 * 24 * 3600_000;
async function openCalendar(nickname, needed, action) {
    const config = await loadConfig();
    const account = findAccount(config, nickname);
    requirePermission(config, account, needed, action);
    return { config, account, cal: await calendarFor(config, account) };
}
/** Opens the calendar after reading the event, since the permission depends on who's invited. */
async function openForChange(nickname, calendar, eventId, timeZone, addsPeople, action) {
    const { config, account, cal } = await openCalendar(nickname, "draft", action);
    const event = await cal.getEvent(calendar, eventId, timeZone);
    if (addsPeople || othersOn(event).length) {
        requirePermission(config, account, "send", `${action} when other people are invited`);
    }
    return { account, cal, event };
}
const calendarArg = z
    .string()
    .optional()
    .describe("A calendar name or id from list_calendars. Leave empty for the main calendar.");
const timeZoneArg = z
    .string()
    .optional()
    .describe('Time zone for times you give and get back, like "America/Chicago". Defaults to this ' +
    "computer's time zone.");
const eventId = z.string().describe("The event id from list_events.");
const people = z
    .array(z.string())
    .optional()
    .describe('Email addresses, optionally with a name: "Sam Lee <sam@example.com>".');
const when = (what) => z
    .string()
    .describe(`${what}: a local time like "2026-10-20T15:00", or a date like "2026-10-20" for an all-day ` +
    "event. For all-day events the end is the last day.");
export function registerCalendarTools(server) {
    // ---------- Reading ----------
    server.registerTool("list_calendars", {
        title: "List calendars",
        description: "List the calendars in an account (its main calendar plus any others it has or can see), " +
            "and whether Claude can add events to each.",
        inputSchema: { inbox },
        annotations: { readOnlyHint: true },
    }, safe(async ({ inbox }) => {
        const { account, cal } = await openCalendar(inbox, "read", "see calendars");
        return ok({ inbox: account.nickname, calendars: await cal.listCalendars() });
    }));
    server.registerTool("list_events", {
        title: "Show calendar events",
        description: 'List events between two times on one account\'s calendar, or every account with inbox "all". ' +
            "Defaults to the next 7 days. Repeating events appear once per occurrence. Each event " +
            "shows its attendees and how this account answered the invite.",
        inputSchema: {
            inbox: inbox.describe('An inbox nickname, or "all" for every account\'s calendar.'),
            start: z.string().optional().describe("From this time or date. Defaults to now."),
            end: z
                .string()
                .optional()
                .describe("Up to this time or date (a date includes that whole day). Defaults to 7 days after start."),
            query: z
                .string()
                .optional()
                .describe("Only events whose title, place or notes contain these words."),
            calendar: calendarArg,
            time_zone: timeZoneArg,
            max_results: z.number().int().min(1).max(100).default(50).describe("Per account."),
        },
        annotations: { readOnlyHint: true },
    }, safe(async ({ inbox, start, end, query, calendar, time_zone, max_results }) => {
        const tz = checkZone(time_zone);
        const config = await loadConfig();
        const targets = inbox.trim().toLowerCase() === "all" ? config.accounts : [findAccount(config, inbox)];
        if (!targets.length)
            throw new Error("No inboxes are connected yet. Use add_account first.");
        const s = start ? parseWhen(start, tz) : { allDay: false, ms: Date.now() };
        const startMs = s.allDay ? toMs(`${s.date}T00:00`, tz) : s.ms;
        let endMs = startMs + WEEK;
        if (end) {
            const e = parseWhen(end, tz);
            endMs = e.allDay ? toMs(`${addDays(e.date, 1)}T00:00`, tz) : e.ms;
        }
        if (endMs <= startMs)
            throw new Error("The end has to be after the start.");
        const q = { calendar, startMs, endMs, query, maxResults: max_results, timeZone: tz };
        const results = await Promise.all(targets.map(async (account) => {
            try {
                const cal = await calendarFor(config, account);
                return { inbox: account.nickname, events: await cal.listEvents(q) };
            }
            catch (err) {
                return {
                    inbox: account.nickname,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }));
        if (results.length === 1 && "error" in results[0])
            throw new Error(results[0].error);
        return ok({ time_zone: tz, results });
    }));
    server.registerTool("get_event", {
        title: "Read a calendar event",
        description: "Read one event in full, including its notes, attendees and video call link.",
        inputSchema: { inbox, event_id: eventId, calendar: calendarArg, time_zone: timeZoneArg },
        annotations: { readOnlyHint: true },
    }, safe(async ({ inbox, event_id, calendar, time_zone }) => {
        const tz = checkZone(time_zone);
        const { account, cal } = await openCalendar(inbox, "read", "see calendar events");
        return ok({
            inbox: account.nickname,
            time_zone: tz,
            ...(await cal.getEvent(calendar, event_id, tz)),
        });
    }));
    // ---------- Making and changing events ----------
    server.registerTool("create_event", {
        title: "Add a calendar event",
        description: "Add an event to a calendar. With attendees, invitations are emailed to them right away, " +
            "so confirm the details with the person first unless they've clearly asked to send. " +
            "Without attendees, it's just added to this account's calendar.",
        inputSchema: {
            inbox,
            title: z.string(),
            start: when("Start"),
            end: when("End")
                .optional()
                .describe("End. Defaults to one hour after start, or the same day for all-day events."),
            location: z.string().optional(),
            description: z.string().optional().describe("Notes, as plain text."),
            attendees: people.describe("People to invite. Each gets an emailed invitation."),
            optional_attendees: people.describe("People to invite as optional."),
            add_video_call: z
                .boolean()
                .optional()
                .describe("Add a Google Meet or Microsoft Teams link, where the account supports it."),
            repeat: z
                .enum(["daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"])
                .optional()
                .describe("Make it a repeating event, starting on the start date, with no end."),
            reminder_minutes: z
                .number()
                .int()
                .min(0)
                .max(40320)
                .optional()
                .describe("Phone/desktop reminder this many minutes before the start (0 = at the start time)."),
            calendar: calendarArg,
            time_zone: timeZoneArg,
        },
        annotations: { openWorldHint: true },
    }, safe(async (args) => {
        const tz = checkZone(args.time_zone);
        const invites = !!(args.attendees?.length || args.optional_attendees?.length);
        const { account, cal } = await openCalendar(args.inbox, invites ? "send" : "draft", invites ? "send calendar invitations" : "add calendar events");
        const range = resolveRange(args.start, args.end, tz);
        const event = await cal.createEvent(args.calendar, {
            title: args.title,
            range,
            timeZone: tz,
            location: args.location,
            description: args.description,
            attendees: args.attendees,
            optionalAttendees: args.optional_attendees,
            videoCall: args.add_video_call,
            repeat: args.repeat,
            repeatDate: range.start.allDay ? range.start.date : formatInZone(range.start.ms, tz).slice(0, 10),
            reminderMinutes: args.reminder_minutes,
        });
        return ok({ inbox: account.nickname, time_zone: tz, invitations_sent: invites, event });
    }));
    server.registerTool("update_event", {
        title: "Change a calendar event",
        description: "Change an event's title, time, place or notes, or add and remove attendees. Give only " +
            "what changes; moving the start keeps the same length unless you give an end. If other " +
            "people are invited they're emailed the update, so confirm with the person first. Use " +
            "the event's seriesId instead of its id to change every occurrence of a repeating event.",
        inputSchema: {
            inbox,
            event_id: eventId,
            title: z.string().optional(),
            start: when("New start").optional(),
            end: when("New end").optional(),
            location: z.string().optional().describe("New place; empty text clears it."),
            description: z.string().optional().describe("New notes; empty text clears them."),
            add_attendees: people.describe("People to invite. Each gets an emailed invitation."),
            remove_attendees: people,
            calendar: calendarArg,
            time_zone: timeZoneArg,
        },
        annotations: { idempotentHint: true, openWorldHint: true },
    }, safe(async (args) => {
        const tz = checkZone(args.time_zone);
        const { account, cal, event } = await openForChange(args.inbox, args.calendar, args.event_id, tz, !!args.add_attendees?.length, "change calendar events");
        if (!event.isOrganizer && othersOn(event).length) {
            throw new Error("Someone else organized this event, so only they can change it. You can accept or " +
                "decline it with respond_to_event, or reply to the organizer by email.");
        }
        const updated = await cal.updateEvent(args.calendar, args.event_id, {
            title: args.title,
            range: args.start || args.end
                ? resolveRange(args.start, args.end, tz, rangeOf(event))
                : undefined,
            timeZone: tz,
            location: args.location,
            description: args.description,
            addAttendees: args.add_attendees,
            removeAttendees: args.remove_attendees,
        });
        return ok({
            inbox: account.nickname,
            time_zone: tz,
            attendees_notified: othersOn(updated).length > 0 || othersOn(event).length > 0,
            event: updated,
        });
    }));
    server.registerTool("respond_to_event", {
        title: "Accept or decline an invitation",
        description: "Answer a meeting invitation: accept, decline, or tentative (maybe). The organizer is " +
            "told, with the optional note. Confirm with the person first.",
        inputSchema: {
            inbox,
            event_id: eventId,
            response: z.enum(["accept", "decline", "tentative"]),
            note: z.string().optional().describe("A short message to the organizer."),
            calendar: calendarArg,
        },
        annotations: { idempotentHint: true, openWorldHint: true },
    }, safe(async ({ inbox, event_id, response, note, calendar }) => {
        const { account, cal } = await openCalendar(inbox, "send", "answer invitations");
        const answer = response === "accept" ? "accepted" : response === "decline" ? "declined" : "tentative";
        await cal.respond(calendar, event_id, answer, note);
        return ok(`Answered "${answer}" from "${account.nickname}" (${account.email}).`);
    }));
    server.registerTool("cancel_event", {
        title: "Cancel a calendar event",
        description: "Remove an event this account organized. If other people were invited, they're emailed " +
            "that it's cancelled (with the optional note, on Microsoft), so confirm with the person " +
            "first. For someone else's meeting, decline it with respond_to_event instead.",
        inputSchema: {
            inbox,
            event_id: eventId,
            note: z.string().optional().describe("A message for the attendees (Microsoft only)."),
            calendar: calendarArg,
        },
        annotations: { destructiveHint: true, openWorldHint: true },
    }, safe(async ({ inbox, event_id, note, calendar }) => {
        const { account, cal, event } = await openForChange(inbox, calendar, event_id, "UTC", false, "cancel calendar events");
        await cal.cancelEvent(calendar, event_id, note);
        const told = othersOn(event).length;
        return ok(`Cancelled "${event.title}" in "${account.nickname}"` +
            (told ? `, and told ${told} ${told === 1 ? "person" : "people"}.` : "."));
    }));
}
//# sourceMappingURL=calendarTools.js.map
