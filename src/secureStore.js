import { promises as fs } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Everything this server keeps (inbox list, sign-ins, Claude connector logins)
 * lives in DATA_DIR, encrypted with SECRET_KEY. Lose the key and the data
 * can't be read; you'd just sign in again.
 */
export function dataDir() {
    return process.env.DATA_DIR || process.env.EMAIL_MCP_HOME || "/data";
}

let key;
function encKey() {
    if (key) return key;
    const secret = process.env.SECRET_KEY;
    if (!secret || secret.length < 24) {
        throw new Error("SECRET_KEY is missing or too short. Set it to a long random value (at least 24 characters).");
    }
    key = scryptSync(secret, "organized-chaos-mail", 32);
    return key;
}

function encrypt(text) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return JSON.stringify({
        v: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: body.toString("base64"),
    });
}

function decrypt(raw) {
    const parsed = JSON.parse(raw);
    if (parsed?.v !== 1 || !parsed.iv) return raw; // plain file (e.g. just imported)
    const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
}

function filePath(rel) {
    if (!/^[\w.\/-]+$/.test(rel) || rel.includes("..")) throw new Error(`Bad storage name: ${rel}`);
    return path.join(dataDir(), rel);
}

export async function readJson(rel) {
    try {
        return JSON.parse(decrypt(await fs.readFile(filePath(rel), "utf8")));
    } catch (err) {
        if (err.code === "ENOENT") return undefined;
        throw err;
    }
}

export async function writeJson(rel, value) {
    const file = filePath(rel);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, encrypt(JSON.stringify(value)), { mode: 0o600 });
    await fs.rename(tmp, file);
}

export async function removeFile(rel) {
    await fs.rm(filePath(rel), { force: true });
}
