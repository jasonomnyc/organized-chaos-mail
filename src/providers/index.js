import { googleClient } from "../auth/google.js";
import { CALENDAR_SCOPES, microsoftToken } from "../auth/microsoft.js";
import { GoogleCalendar } from "../calendar/google.js";
import { OutlookCalendar } from "../calendar/outlook.js";
import { GmailProvider } from "./gmail.js";
import { OutlookProvider } from "./outlook.js";
import { IcloudProvider } from "./icloud.js";
const providers = new Map();
const calendars = new Map();
export async function providerFor(config, account) {
    const cached = providers.get(account.id);
    if (cached)
        return cached;
    const provider = account.provider === "gmail"
        ? new GmailProvider(await googleClient(config, account))
        : account.provider === "icloud"
            ? new IcloudProvider(account)
            : new OutlookProvider(() => microsoftToken(config, account));
    providers.set(account.id, provider);
    return provider;
}
export async function calendarFor(config, account) {
    const cached = calendars.get(account.id);
    if (cached)
        return cached;
    if (account.provider === "icloud")
        throw new Error(`"${account.nickname}" is iCloud mail only; its calendar isn't connected.`);
    const calendar = account.provider === "gmail"
        ? new GoogleCalendar(await googleClient(config, account))
        : new OutlookCalendar(() => microsoftToken(config, account, CALENDAR_SCOPES), account.email);
    calendars.set(account.id, calendar);
    return calendar;
}
export function forgetProvider(accountId) {
    const p = providers.get(accountId);
    if (p && typeof p.client?.logout === "function") p.client.logout().catch(() => { });
    providers.delete(accountId);
    calendars.delete(accountId);
}
//# sourceMappingURL=index.js.map
export function forgetAllProviders() {
    providers.clear();
    calendars.clear();
}
