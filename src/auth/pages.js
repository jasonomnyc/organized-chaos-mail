const style = `
:root{--bg:#f4f3ef;--card:#fff;--ink:#1d1d1b;--muted:#6b6a65;--accent:#d9532b;--line:#e4e2dc;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#21211f;--ink:#f1efe9;--muted:#a3a19a;--line:#34332f;--bad:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
main{max-width:30rem;margin:10vh auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:1.3rem;margin:0 0 .5rem}p{color:var(--muted);margin:.4rem 0 1rem}
.brand{font-weight:700;letter-spacing:-.01em;margin-bottom:1rem}.brand b{color:var(--accent)}
label{display:block;font-weight:600;margin:.8rem 0 .3rem}input[type=password],input[type=text]{width:100%;padding:.7rem;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--bg);color:var(--ink)}
button{margin-top:1rem;width:100%;padding:.75rem;border:0;border-radius:8px;background:var(--accent);color:#fff;font:600 1rem system-ui;cursor:pointer}
.err{color:var(--bad);font-weight:600}.ok{color:#2e7d32;font-weight:600}code{font-size:.9em}small{color:var(--muted)}
`;
export function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
export const page = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${style}</style></head><body><main><div class="brand">organized <b>chaos</b> · mail</div><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;

export const SUCCESS_PAGE = page("You're signed in", "<p>Your inbox is connected. You can close this tab and go back to Claude.</p>");
export const errorPage = (detail) => page("Sign-in didn't work", `<p>Go back to Claude and try again.</p><p class="err">${escapeHtml(detail)}</p>`);

export function loginPage({ action, loginId, clientName, error, expired }) {
    if (expired) return page("This link expired", "<p>Start connecting again from Claude.</p>");
    return page("Connect Claude to your mail", `
<p>${escapeHtml(clientName || "Claude")} wants to use your inboxes and calendars on this server. Enter this server's owner password to allow it.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="login_id" value="${escapeHtml(loginId)}">
<label for="pw">Owner password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
<button type="submit">Allow</button>
</form>`);
}
