# Organized Chaos Mail

An always-on connector for Organized Chaos. It connects several Gmail and Microsoft 365 / Outlook inboxes and calendars, plus several Slack workspaces, to Claude as one custom connector. It also sends optional SMS reminders through Twilio.

- Every person runs their own copy, locked with their own owner password.
- Inbox sign-ins are encrypted on disk with `SECRET_KEY`.
- Desktop-version users can import their existing sign-ins at `/import`.

**Setup guide:** https://claude.ai/artifact/RcVnbZmtm8sFETVtRDyQ4k

## Settings (environment variables)

| Variable | Required | What it is |
| --- | --- | --- |
| `PUBLIC_URL` | yes | This server's https address |
| `OWNER_PASSWORD` | yes | Typed when Claude connects (10+ characters) |
| `SECRET_KEY` | yes | Encrypts saved sign-ins (24+ random characters) |
| `DATA_DIR` | no | Where data is kept (default `/data`; mount a volume there) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Gmail | Google "Web application" OAuth client |
| `MICROSOFT_CLIENT_ID` | for Microsoft | Entra app registration (public client) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | for texts | Twilio account and number |
| `OWNER_PHONE` / `TEXT_ALLOWED_TO` | for texts | The only numbers texts may go to |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | for Slack | Slack app (user token scopes, public distribution on) |

Run locally with `npm ci && npm start`. In Claude, the connector URL is `<PUBLIC_URL>/mcp`.
