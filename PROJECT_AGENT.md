# TravelCanary project notes

This checkout is the canonical public application (`hypertrial/travelcanary`).
Pad work for it shares `travelcanary-risk-engineering` with the private
`travelcanary-risk` wrapper. Every Work item in that workspace MUST start with
`Repository: travelcanary`.

Public application work stays in this repository. Private wrapper operations
(`docs/OPERATIONS.md`, environment examples, Vercel configuration, the `app/`
submodule pin, `PUBLIC_APP_COMMIT`) stay in `travelcanary-risk`. Never copy
private wrapper content into this public repository.

Use the workspace from `.pad.toml`. Follow `AGENTS.md` and the local
`pad-engineering` skill.

## Invariants

- Preserve the public/private data boundary documented in `docs/DATA_POLICY.md`
  and `PUBLIC_PROVENANCE.md`.
- Never commit credentials, local databases, backups, raw upstream captures, or
  operator state.
- Keep Snapshot V10/V11 and Conditions V2/V3 wire contracts backward compatible.
- Treat generated catalogs, mappings, and `data/source-inventory.json` as
  reproducible artifacts; use their checked-in generators.
- Do not enable gated or blocked sources without a completed source review,
  bounded fixtures, and tests.

## Verification

Wrappers (do not rewrite without a dedicated ticket):

- Fast: `npm run check:fast`
- Completion: `npm run check:full` from a clean exact-SHA checkout before
  release work

Native GitHub CI is the independent verification source.
