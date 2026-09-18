# TravelCanary project notes

This checkout is the canonical public application (`hypertrial/travelcanary`). Pad work shares the `travelcanary-vercel-engineering` workspace with the private `travelcanary-vercel` wrapper. Every Work or Plan item must begin with its repository name.

The public repository owns all application code, deployment configuration, environment-variable documentation, Docker/systemd support, and generated public/demo data. The private wrapper owns only the exact `travelcanary/` gitlink, Pad metadata, wrapper verification, and concise private deployment notes. Never copy private deployment evidence, credentials, or operator state into this repository.

## Invariants

- Preserve the public/private data boundary in `docs/DATA_POLICY.md` and `PUBLIC_PROVENANCE.md`.
- Never commit credentials, local databases, backups, raw upstream captures, or operator state.
- Keep Snapshot V11 and Conditions V3 wire contracts backward compatible.
- Catalog 3 is the only active catalog; V1–V15 state readers are migration-only.
- Only `catalogs/3/publication/latest.json` is mutable. Immutable objects and manifests never change.
- The web process reads only public publication storage. The collector alone writes private state and public generations.
- Treat catalogs, mappings, demo objects, and `data/source-inventory.json` as reproducible artifacts.
- Do not enable gated or blocked sources without completed evidence, bounded fixtures, and tests.

## Verification

- Development: `scripts/verify-fast`
- Completion: `scripts/verify` from a clean exact-SHA checkout
- Release: exact-SHA `npm run verify:production`, a green Vercel Preview, and production health/liveness

Never push directly to `main`.
