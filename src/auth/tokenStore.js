import { readJson, removeFile, writeJson } from "../secureStore.js";

/** Inbox sign-ins, one encrypted file each under DATA_DIR/tokens. */
function rel(name) {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`Bad token name: ${name}`);
    return `tokens/${name}.json`;
}

export function readToken(name) {
    return readJson(rel(name));
}

export function writeToken(name, value) {
    return writeJson(rel(name), value);
}

export function deleteToken(name) {
    return removeFile(rel(name));
}
