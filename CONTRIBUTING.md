# Contributing to TravelCanary

TravelCanary welcomes focused bug fixes, tests, source reviews, accessibility improvements, and carefully bounded coverage additions.

## Development

Use the pinned Node and npm versions from `.nvmrc` and `package.json`:

```bash
npm ci
scripts/verify-fast
```

Before opening a release-bound pull request, run `scripts/verify` from a clean checkout at the exact commit being proposed. Generated data must be updated through the scripts in `package.json`, never by hand.

## Source and data changes

Every source change must document access, reuse rights, attribution, response bounds, update cadence, failure behavior, and a reproducible minimized fixture. Follow [the public data policy](docs/DATA_POLICY.md) and preserve all applicable notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Do not submit credentials, private ingestion state, production snapshots, raw upstream captures, personal data, paywall or access-control workarounds, undocumented private endpoints, or unreviewed scraping. A connector that has not passed its technical and legal gate must remain unable to make requests.

## Pull requests

Keep changes reviewable and include the commands actually run. Do not silently change the public wire contracts, safety semantics, or source licensing behavior.
