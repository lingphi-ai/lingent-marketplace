---
name: add-platform
description: Autonomously onboard a new platform into the Lingent marketplace — drive the platform's web app with a browser MCP, observe its real API traffic, analyze it, and write a signed-ready session-bridge manifest + catalog entry. Use when the user wants to add a platform (e.g. "add Gitee / 飞书 / Linear to the marketplace").
---

# Autonomous platform onboarding

You (Claude Code) drive a real browser, observe the platform's API, analyze it, and write the pack. This automates everything **except** the one unavoidable human step: **logging in** (the session is the user's credential — no agent can self-supply it).

## The one human prerequisite
The browser you drive MUST be logged into the target platform. Two ways to get that:
- **Attach to the user's Chrome** (best, most hands-off): the user runs Chrome with `--remote-debugging-port=9222` and stays logged into the platform; you connect via the **chrome-devtools MCP** (`list_pages` → `select_page`) and drive their real, authed tabs.
- **Log in once in the agent browser**: use the **playwright MCP** (`browser_navigate`), and when the platform shows its login page, ask the user to complete login in that visible browser, then continue. A fresh agent browser has NO session and most platforms (e.g. Gitee) redirect to login + may anti-bot a headless context — so confirm you're past login before observing.

If neither is available, STOP and tell the user you need a logged-in browser; do not fabricate endpoints.

## Procedure (per platform)
Inputs: platform `--url`, an `id` slug (e.g. `gitee`), display `name`, host glob(s) (e.g. `gitee.com/*`).

1. **Reach a logged-in state** (see prerequisite). Verify you're authenticated (the page shows the user's account, not a login form).
2. **Auto-explore — READ-ONLY.** Navigate the platform's main read surfaces (search, lists, an item detail) to generate API traffic. SAFETY: only follow GET/navigation links and submit SEARCH inputs. NEVER click anything matching `delete|remove|logout|sign.?out|删除|退出|注销|新建|提交|create|submit|pay|transfer` — no writes, no destructive actions, no logout. A few read pages is enough.
3. **Observe the API.** Use `browser_network_requests` (filter to the platform host's `/api`/json XHR; `static:false`). For the useful endpoints capture: method, URL (template ids → `{param}`), query/body params, and a response sample. Also find the CSRF source: look for `<meta name=*csrf*>` / `*xsrf*` (via `browser_evaluate`) or a csrf/xsrf cookie.
4. **Analyze + generate the manifest.** Build an `HttpPlatformManifest` (match `packs/jira-cloud.lingphi-platform.json` exactly — that's the session-bridge reference): `{ id:"<id>-manifest", version, displayName, description, hosts:[...], baseUrl, auth:{type:"cookie"<,csrf:{source,name,headerName}>}, transport:{preferred:"cs"}, tools:[...] }`. NO top-level `kind` (installer defaults http). NO `signature`/`trustLevel` (added by signing). Each tool: snake_case `name` (e.g. `gitee_list_repo_pulls`), one-line `description`, `method`, `path` (templated), `params[]` (name, in: path|query|body, type, required, description), `responseType:"json"`, and `requiresApproval:true` for any non-GET/state-changing tool. Keep the 8–15 most useful tools; skip analytics/telemetry/static.
5. **Write the files.** Save `packs/<id>.lingphi-platform.json`. Add a `catalog.json` entry under the right category with `manifestUrl: "https://raw.githubusercontent.com/lingphi-ai/lingent-marketplace/main/packs/<id>.lingphi-platform.json"`, `integrationType:"<id>"`, sensible `iconColor`. Validate both are valid JSON and the pack's top-level keys match the jira pack (minus signature/trustLevel).
6. **Report, do NOT sign/push.** Summarize the tools generated + the auth/CSRF detected. Tell the user to: (a) load the unsigned pack into the extension (local install) and test a couple of tools against their live session, (b) `node scripts/sign-packs.mjs` to sign, (c) commit + push. Signing needs the official `lingphi-official-2026` private key, which only the user has — never invent or skip the signature.

## Verification you CAN do without extra login
- The emitted manifest is valid JSON and structurally matches `packs/jira-cloud.lingphi-platform.json` (cookie auth + cs transport + tools[]).
- `catalog.json` stays valid and the new entry has a `manifestUrl` (entries without one show "no installable pack" in the extension).

## Notes
- This is the curated half of the strategy; the extension's built-in **deep-scan** agent is the self-service long-tail path for users without a curated pack.
- Prefer cookie/cs (session bridge) over API-token packs — it reuses the user's existing login, no per-platform token setup (the github pack is the bearer/PAT exception).
- Batchable: once a platform's login is established in the attached browser, repeat steps 2–5 for additional platforms the user is logged into.

## Persistent browser (reuse logins across platforms + sessions)
Don't relaunch/close per platform. Keep ONE long-lived logged-in browser:
- `scripts/scaffold-browser.sh` launches Chrome with a PERSISTENT profile (`$HOME/.lingent/scaffold-chrome-profile`, not /tmp) on a fixed debug port (9222), idempotent. Run once, log into every target platform, leave open.
- Claude Code ATTACHES over CDP (chrome-devtools MCP, or playwright connectOverCDP to `http://127.0.0.1:9222`) and **only navigates/observes — never `close`** (use disconnect). The browser + logins persist across every onboarding run and across Claude Code sessions (cookies live in the profile dir; only re-login when a platform's session actually expires).
- Within a single live session, the simplest form: open the browser once, log into all platforms, and DO NOT close it between platforms.
- **Google-login platforms**: do the Google sign-in in a NON-debug launch first — `scripts/scaffold-browser.sh login` opens the persistent profile WITHOUT a debug port (not automation-flagged, so Google allows login). Log into Google + platforms, quit, then `scripts/scaffold-browser.sh` relaunches with the debug port; the automation reuses the established sessions (no re-login, no Google 'browser may not be secure' block). Never use stealth/anti-detection to bypass Google's check.
- **Extension loaded**: `scaffold-browser.sh` loads the Lingent extension (`$LINGENT_DIST`, default `~/Projects/Lingphi/chrome-extension/dist` — `npm run build` first) via `--load-extension`, in BOTH login and attach modes. So the same persistent, logged-in browser can (a) test a generated pack via local manifest install, and (b) run the in-extension deep-scan against your live sessions. If Chrome shows a 'disable developer-mode extensions' bubble, keep it enabled.
