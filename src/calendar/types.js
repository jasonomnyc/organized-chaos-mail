/** Provider-neutral calendar shapes. IDs are only meaningful within their own account. */
import { parseAddressList } from "../providers/types.js";
export const MAX_DESCRIPTION_CHARS = 5_000;
export const LIST_DESCRIPTION_CHARS = 300;
export function clip(text, max) {
    const t = text?.trim();
    if (!t)
        return undefined;
    return t.length > max ? t.slice(0, max) + "…" : t;
}
/**
 * People other than this account on the event: if any, changes notify them.
 * Microsoft leaves the organizer off the attendee list, so they're added here.
 */
export function othersOn(event) {
    const others = event.attendees.filter((a) => !a.self);
    const organizer = event.organizer;
    if (!event.isOrganizer && organizer) {
        const email = organizer.email.toLowerCase();
        if (!event.attendees.some((a) => a.email.toLowerCase() === email))
            others.push(organizer);
    }
    return others;
}
/** Parses "Sam Lee <sam@x.com>" style entries, refusing anything that isn't an address. */
export function people(list) {
    const out = [];
    for (const raw of list ?? []) {
        for (const a of parseAddressList(raw)) {
            if (!/^[^\s@<>]+@[^\s@<>]+$/.test(a.email)) {
                throw new Error(`"${raw}" isn't an email address.`);
            }
            out.push(a);
        }
    }
    return out;
}
//# sourceMappingURL=types.js.map