# About this repo

This repo is used for hosting public releases of Finch.

## Release sync

Use `.github/workflows/sync-releases.yml` to manually mirror releases from another GitHub repo into this repo.

Recommended one-off inputs:
- `source_repo`: `puterjam/finch`
- `target_repo`: `finchtoys/finch-releases`
- `include_drafts`: `false`
- `overwrite_assets`: `false`
- `overwrite_body`: `false`
- `skip_existing_releases`: `true`
- `max_releases`: `0`
