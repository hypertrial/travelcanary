# Public data policy

TravelCanary includes reviewed source adapters and enough minimized fixtures to test them without contacting upstream services. Inclusion does not mean every adapter is allowed to run. The generated `data/source-inventory.json` assigns each source one of four policies:

- `open`: reviewed and enabled by default. Existing attribution and reuse terms still apply.
- `restricted`: lawful reuse has noncommercial or similarly restrictive terms. Self-hosted collection is disabled until the operator explicitly accepts the current restricted-source manifest digest. Visitors receive a persistent disclosure while these sources are active.
- `gated`: retained for parity and continued review, but makes zero requests until its documented legal and technical gate passes.
- `blocked`: documentation or official links only. TravelCanary does not fetch it.

TravelCanary does not bypass authentication, paywalls, bot controls, or access controls; use undocumented private endpoints; or perform unreviewed scraping. A failed source gate is a reason to keep the connector off, not to evade the gate.

Restricted-source acceptance applies only to the exact reviewed manifest digest. Changing that manifest disables restricted collection until the operator reviews and accepts it again. Operators are responsible for confirming that their use satisfies each source's current terms.

Public snapshots and conditions objects contain only the validated wire contracts consumed by the browser. Collector leases, cursors, errors, policy records, credentials, raw responses, and other ingestion state are private and must never be served from public routes or included in support bundles.
