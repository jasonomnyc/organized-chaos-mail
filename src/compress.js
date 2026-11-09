import zlib from "node:zlib";

/**
 * Compresses replies (gzip, or brotli when offered) when the caller says it accepts them. Replies are buffered and
 * compressed in one go; anything that streams (text/event-stream) or is under 1 KB is sent as is.
 * Written here instead of adding a package, so deploying needs no new dependency.
 */
const MIN_BYTES = 1024;

export function compressReplies(req, res, next) {
    const accept = String(req.headers["accept-encoding"] || "");
    const enc = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
    if (!enc || req.method === "HEAD") return next();
    const chunks = [];
    let streaming = false, headArgs = null;
    const write = res.write.bind(res), end = res.end.bind(res), writeHead = res.writeHead.bind(res);
    const isStream = () => /text\/event-stream/i.test(String(res.getHeader("content-type") || "")) ||
        (headArgs && JSON.stringify(headArgs).toLowerCase().includes("text/event-stream"));
    const passThrough = () => {
        streaming = true;
        res.writeHead = writeHead;
        if (headArgs) writeHead(...headArgs);
        for (const c of chunks) write(c);
        chunks.length = 0;
    };
    res.writeHead = (...args) => { headArgs = args; if (isStream()) passThrough(); return res; };
    res.write = (chunk, encoding, cb) => {
        if (streaming) return write(chunk, encoding, cb);
        if (isStream()) { passThrough(); return write(chunk, encoding, cb); }
        if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8"));
        if (typeof encoding === "function") encoding(); else if (typeof cb === "function") cb();
        return true;
    };
    res.end = (chunk, encoding, cb) => {
        if (typeof chunk === "function") { cb = chunk; chunk = null; }
        else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
        if (streaming) return end(chunk ?? undefined, encoding, cb);
        if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8"));
        const body = Buffer.concat(chunks);
        // Node calls res.writeHead itself while sending, so the real one must be back in place first.
        res.writeHead = writeHead;
        // Header values given to writeHead (e.g. content-type) are folded in so they survive.
        let status = res.statusCode;
        if (headArgs) {
            const [code, a, b] = headArgs;
            status = code;
            const hdrs = typeof a === "object" && a !== null ? a : typeof b === "object" && b !== null ? b : null;
            if (typeof a === "string") res.statusMessage = a;
            // Node accepts headers as an object, a list of [name, value] pairs, or a flat [name, value, ...] list.
            if (Array.isArray(hdrs)) {
                if (hdrs.length && Array.isArray(hdrs[0])) for (const [k, v] of hdrs) res.setHeader(k, v);
                else for (let i = 0; i + 1 < hdrs.length; i += 2) res.setHeader(hdrs[i], hdrs[i + 1]);
            }
            else if (hdrs) for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
        }
        res.statusCode = status;
        const already = res.getHeader("content-encoding");
        if (body.length < MIN_BYTES || already || status === 204 || status === 304) {
            if (!already) res.setHeader("content-length", body.length);
            return end(body, cb);
        }
        const out = enc === "br"
            ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
            : zlib.gzipSync(body, { level: 6 });
        res.setHeader("content-encoding", enc);
        res.setHeader("vary", "Accept-Encoding");
        res.setHeader("content-length", out.length);
        return end(out, cb);
    };
    next();
}
