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
| **SharePoint** | Session cookie (open SharePoint tab) | One site per instance (`/sites/...` in the Site URL). List + search tools; folder/page tools needing server-relative paths are omitted (IIS rejects encoded slashes). |
| **Azure (ARM)** | ARM bearer token | Read-only Resource Manager tools (`management.azure.com`). The former built-in extracted a token from an open Portal tab; this pack uses an explicit `az account get-access-token` token. Graph / Log Analytics hosts are out of scope. |

## Adding a platform

1. Add `packs/<id>.lingphi-platform.json`.
2. Add an entry to `catalog.json` under the right category with a `manifestUrl`
   pointing at the raw pack URL.
