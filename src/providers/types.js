/** Provider-neutral email shapes. IDs are only meaningful within their own inbox. */
export const MAX_BODY_CHARS = 20_000;
export function truncateBody(body) {
    if (body.length <= MAX_BODY_CHARS)
        return { body, truncated: false };
    return { body: body.slice(0, MAX_BODY_CHARS), truncated: true };
}
/** Parses "Name <a@b.com>, c@d.com" into addresses. */
export function parseAddressList(header) {
    if (!header)
        return [];
    const out = [];
    // Split on commas that aren't inside quotes or angle brackets.
    const parts = header.match(/(?:"[^"]*"|<[^>]*>|[^,])+/g) ?? [];
    for (const raw of parts) {
        const part = raw.trim();
        if (!part)
            continue;
        const m = part.match(/^(.*?)\s*<([^>]+)>$/);
        if (m) {
            const name = m[1].replace(/^"|"$/g, "").trim();
            out.push(name ? { name, email: m[2].trim() } : { email: m[2].trim() });
        }
        else {
            out.push({ email: part });
        }
    }
    return out;
}
//# sourceMappingURL=types.js.map