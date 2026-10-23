import { page } from "./auth/pages.js";

/** Lets the owner pick their .email-mcp folder; the browser reads it and sends it here over HTTPS. */
export function importPage() {
    return page("Import from the desktop version", `
<p>Brings your inboxes over already signed in, so you don't have to sign in to each one again.</p>
<label for="pw">Owner password</label>
<input id="pw" type="password" autocomplete="current-password">
<label for="dir">Your <code>.email-mcp</code> folder</label>
<small>On Windows it's <code>C:\\Users\\&lt;you&gt;\\.email-mcp</code>. Use a computer for this step.</small>
<input id="dir" type="file" webkitdirectory multiple style="margin-top:.5rem">
<details style="margin-top:1rem"><summary>App keys (only if the import asks for them)</summary>
<small>In the Claude app: Settings → Extensions → Email and Calendar → Configure.</small>
<label for="gid">Google client ID</label><input id="gid" type="text">
<label for="gsec">Google client secret</label><input id="gsec" type="password">
<label for="mid">Microsoft client ID</label><input id="mid" type="text">
</details>
<button id="go" type="button">Import</button>
<p id="out" aria-live="polite"></p>
<script>
document.getElementById("go").onclick = async () => {
  const out = document.getElementById("out");
  const picked = [...document.getElementById("dir").files];
  if (!picked.length) { out.className = "err"; out.textContent = "Pick your .email-mcp folder first."; return; }
  const files = {};
  for (const f of picked) {
    const parts = f.webkitRelativePath.split("/").slice(1);
    const rel = parts.join("/");
    if (rel === "config.json" || /^tokens\\/[\\w.-]+\\.json$/.test(rel)) files[rel] = await f.text();
  }
  out.className = ""; out.textContent = "Importing…";
  try {
    const r = await fetch("/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      password: document.getElementById("pw").value, files,
      keys: { googleClientId: gid.value, googleClientSecret: gsec.value, microsoftClientId: mid.value } }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Import failed");
    out.className = "ok";
    out.textContent = "Done. Connected: " + data.imported.join(", ") + (data.skipped.length ? ". Skipped: " + data.skipped.join(", ") : ".");
  } catch (e) { out.className = "err"; out.textContent = e.message; }
};
</script>`);
}
