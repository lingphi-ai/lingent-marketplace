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

## Adding a platform

1. Add `packs/<id>.lingphi-platform.json`.
2. Add an entry to `catalog.json` under the right category with a `manifestUrl`
   pointing at the raw pack URL.
