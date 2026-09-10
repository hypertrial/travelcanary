# Repository guidance

- Preserve the public/private data boundary documented in `docs/DATA_POLICY.md` and `PUBLIC_PROVENANCE.md`.
- Never commit credentials, local databases, backups, raw upstream captures, or operator state.
- Keep Snapshot V10/V11 and Conditions V2/V3 wire contracts backward compatible.
- Run `scripts/verify-fast` while developing and `scripts/verify` from a clean exact-SHA checkout before release work.
- Treat generated catalogs, mappings, and `data/source-inventory.json` as reproducible artifacts; use their checked-in generators.
- Do not enable gated or blocked sources without a completed source review, bounded fixtures, and tests.
