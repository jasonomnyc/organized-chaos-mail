import { randomBytes } from "node:crypto";
/** Builds a plain-text RFC 5322 message for Gmail's raw upload, with attachments as multipart/mixed. */
/** Encodes a header value as RFC 2047 when it isn't plain ASCII. */
export function encodeHeader(value) {
    if (/^[\x20-\x7e]*$/.test(value))
        return value;
    return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
function checkHeaderSafe(value, name) {
    if (/[\r\n]/.test(value))
        throw new Error(`${name} can't contain line breaks.`);
}
export function buildMime(msg) {
    const headers = [];
    if (msg.from)
        headers.push(["From", msg.from]);
    headers.push(["To", msg.to.join(", ")]);
    if (msg.cc?.length)
        headers.push(["Cc", msg.cc.join(", ")]);
    if (msg.bcc?.length)
        headers.push(["Bcc", msg.bcc.join(", ")]);
    headers.push(["Subject", encodeHeader(msg.subject)]);
    if (msg.inReplyTo)
        headers.push(["In-Reply-To", msg.inReplyTo]);
    if (msg.references)
        headers.push(["References", msg.references]);
    headers.push(["MIME-Version", "1.0"]);
    const body = wrap64(Buffer.from(msg.body.replace(/\r?\n/g, "\r\n"), "utf8"));
    const files = msg.attachments ?? [];
    if (!files.length) {
        headers.push(["Content-Type", 'text/plain; charset="UTF-8"']);
        headers.push(["Content-Transfer-Encoding", "base64"]);
        for (const [name, value] of headers)
            checkHeaderSafe(value, name);
        return headers.map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n" + body;
    }
    const boundary = "=_oc_" + randomBytes(12).toString("hex");
    headers.push(["Content-Type", `multipart/mixed; boundary="${boundary}"`]);
    for (const [name, value] of headers)
        checkHeaderSafe(value, name);
    const parts = [
        `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`,
        ...files.map((f) => {
            const name = String(f.filename || "attachment").replace(/[\r\n"\\]/g, "_");
            const ascii = name.replace(/[^\x20-\x7e]/g, "_");
            const type = String(f.mimeType || "application/octet-stream").replace(/[\r\n";]/g, "");
            return (`Content-Type: ${type}; name="${encodeHeader(name)}"\r\n` +
                `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}\r\n` +
                `Content-Transfer-Encoding: base64\r\n\r\n${wrap64(f.data)}`);
        }),
    ];
    return (headers.map(([k, v]) => `${k}: ${v}`).join("\r\n") +
        "\r\n\r\n" +
        parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") +
        `\r\n--${boundary}--\r\n`);
}
function wrap64(buf) {
    return buf.toString("base64").replace(/.{76}/g, "$&\r\n");
}
/** Largest total attachment size accepted for one message (Gmail and Outlook both cap near 25 MB after encoding). */
export const MAX_ATTACH_BYTES = 18 * 1024 * 1024;
export function checkAttachmentSize(files) {
    const total = files.reduce((n, f) => n + f.data.length, 0);
    if (total > MAX_ATTACH_BYTES)
        throw new Error(`The attachments add up to ${(total / 1048576).toFixed(1)} MB, more than the 18 MB an email can carry. Share large files as a link instead.`);
}
const MIME_BY_EXT = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    heic: "image/heic", txt: "text/plain", csv: "text/csv", htm: "text/html", html: "text/html", zip: "application/zip",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    eml: "message/rfc822", json: "application/json", xml: "application/xml",
};
export function guessMime(filename) {
    const ext = String(filename || "").split(".").pop()?.toLowerCase() ?? "";
    return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
export function base64url(s) {
    return Buffer.from(s, "utf8").toString("base64url");
}
/** Adds "Re: " unless the subject already starts with it. */
export function replySubject(subject) {
    return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}
//# sourceMappingURL=mime.js.map