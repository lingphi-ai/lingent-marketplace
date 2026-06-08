# Lingent Marketplace

Platform catalog and declarative platform packs for the [Lingent](https://lingphi.com) Chrome extension.

Lingent ships as a clean general-purpose browser agent. Platform integrations
(Jira, GitHub, …) live here as `.lingphi-platform.json` manifest packs and are
installed on demand from the in-app marketplace.

## Layout

- `catalog.json` — the platform catalog the extension fetches (Settings → Advanced →
  Platform catalog URL). Each entry links to its pack via `manifestUrl`.
- `packs/*.lingphi-platform.json` — declarative platform manifests (auth, hosts,
  transport, tools). Schema: `lingphi-platform.schema.json` in the extension repo.

## Catalog URL

```
https://raw.githubusercontent.com/lingphi-ai/lingent-marketplace/main/catalog.json
```

## Available platforms

| Platform | Auth | Notes |
|---|---|---|
| **Jira Cloud** | Session cookie (open Jira tab) | Full issue/search/comment/transition coverage via `*.atlassian.net` REST v2. |
| **GitHub** | Personal Access Token (bearer) | Faithful port of the former built-in: code/PR/issue/repo tools against `api.github.com`. The old DOM-only `github_fill_comment` is dropped. |
| **SharePoint** | Session cookie (open SharePoint tab) | Full port: discover/list/page/file/search tools. The site is passed per call (one connection covers the whole tenant); server-relative folder paths are sent verbatim. |
| **Azure** | Session of open Azure Portal tab | Full port: ARM resource/alert/log/metric tools **and** Entra (Graph) directory tools. The bearer token is harvested from the Portal's MSAL cache at call time (`pageToken` auth) and matched to the target host — exactly like the former built-in. |

These two rely on manifest capabilities added for in-page-bridge parity: `pageToken` auth (harvest a token from a logged-in tab's storage), per-tool `baseUrl` (multi-host: ARM + Graph), param-driven base URLs (per-call site), and `encode: false` path params (server-relative paths).

## Trust & signing

Packs are **signed**. The extension bundles the public key and installs a
`trustLevel: "verified"` pack only if its signature verifies — so a tampered or
unofficial pack served from a look-alike URL is rejected. This matters because
some packs (e.g. Azure) harvest a session token from a logged-in tab.

- `scripts/sign-packs.mjs` signs every `packs/*.lingphi-platform.json` and writes
  the `signature` block. The signature covers the whole manifest (minus the
  `signature` field) using RSASSA-PKCS1-v1_5 / SHA-256.
- `keys/signing-public.pem` is committed; the matching private key lives in CI
  secrets and is **gitignored** (`keys/signing-private.pem`).
- The same public key is embedded in the extension at
  `src/shared/platformManifest/trustedKeys.ts` (keyId `lingphi-official-2026`).

```
node scripts/sign-packs.mjs          # sign all packs (generates a keypair on first run)
node scripts/sign-packs.mjs --verify # verify signatures, no writes
```

## Adding a platform

1. Add `packs/<id>.lingphi-platform.json`.
2. Add an entry to `catalog.json` under the right category with a `manifestUrl`
   pointing at the raw pack URL.
3. Run `node scripts/sign-packs.mjs` to sign it.

> The bundled fallback catalog inside the extension is replaced wholesale by this
> remote `catalog.json` when reachable — so `catalog.json` also lists the built-in
> Web Search and the custom MCP / OpenAPI / Web App entries, not just packs.
