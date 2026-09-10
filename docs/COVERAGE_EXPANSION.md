# Coverage follow-up — 2026-09-08

The implementation restores NDW traffic context through its current DATEX3 envelope and adds six destinations with Irish OPW river-level context: Cork, Dublin, Galway, Killarney National Park, Limerick and Waterford. These provisional point observations do not establish flood-warning coverage, represent whole rivers, or change alert severity. Existing source and publication budgets remain in force. Disable OPW with `CONDITIONS_DISABLED_SOURCES=opw-hydro` (preserve any existing disabled IDs) for rollback.

Production verification separates fresh, expired, absent and unknown mapped observations. Only genuinely empty, recently successful event feeds receive healthy-empty credit. A bounded live investigation found current IPMA and ARSO readings while public files had missing/expired observations; it did not establish a parser defect. Publication timing and upstream failures still need operational recovery evidence after rollout. Freshness limits were not widened. NDW had a confirmed DATEX2-only envelope failure. The repaired reader accepts the official DATEX3 wrapper, preserves DATEX2 compatibility and requires a current publication. The recorded SRTI/closure replay returned context for 29/13 destinations respectively (overlapping scopes), with existing per-destination limits. Routine maintenance vehicles are excluded. Ambiguous `other` causes with descriptions are conservatively excluded, which can omit legitimate closures; unsupported schedules fail the feed and retain prior unexpired records.

Coverage measurements count reviewed applicable destination–hazard pairs, separating full/partial support and freshness. Incident-only applicability overrides do not change the denominator. Local history compares the same catalog and coverage contract, rejects duplicate sampling times, and reports sampled means rather than uptime. Official incident capture compares explicit headlines, evidence publication times, URLs and expected destinations; reviewed samples cannot establish population-wide recall.

## Source gates still blocking activation

The current Luxembourg parser also recognizes uniformly marked CAP-LU test messages, including `Actual/Public` messages whose exact `cb-eu-level` parameter is `TEST` in every language. These produce no warnings or lifecycle changes. Conflicting or missing sibling markers fail closed; free-text test wording alone never suppresses an alert.

A second bounded operational sample found Finland and Latvia publication timestamps had advanced to 2026-09-08 09:27 UTC without this PR deployed. Their earlier delay remains unexplained by public output. Replaying all 48 Autobahn targets with production limits succeeded for 46; A1 and A7 closure responses exceeded the 64 KiB limit. That reproduces budget-limited partial coverage, without proving the cause of a particular earlier production attempt. No response or freshness budget was widened.

| Recommendation | Evidence and remaining gate |
| --- | --- |
| Germany BBK/NINA | Current reviewed RSS feeds are empty. Federal unchanged-warning reuse does not establish all state/municipal issuer rights or transformed presentation rights. Real emergency/update/cancel fixtures, exact geography and withdrawal semantics remain required. |
| Belgium BE-Alert | Public gateway returns a JSON envelope with linked CAP. The historical item inspected was registration confirmation/test content, not an emergency. Real emergency lifecycle and gateway issuer reuse remain unresolved. |
| Portugal ANEPC | Successor ArcGIS service is identified in the manifest. It contains points and distinct active/resolution/surveillance states, not evacuation perimeters. Pagination is required; old catalog licensing has not been connected to this successor dataset. |
| Greece 112 | CC BY-NC-SA and unchanged-content terms require a transformation decision. Static protection guidance is not a current alert feed; current geometry and lifecycle remain unverified. |
| Italian volcanic restrictions | Scientific activity levels cannot substitute for local restrictions. Historical municipal ordinances do not establish a complete current inventory, effective/revoked status, reusable extraction or exact affected zones. |
| Sixteen EAWS mapping candidates | September feeds returned 404. Sampled winter bulletins disprove several IDs and expose city/served-terrain and elevation ambiguity. Per-candidate evidence is in `data/review-inputs/eaws-expansion-review.json`; none is activated. |
| Additional flood mappings | Existing Austrian/Swiss reviewed mappings cover their catalog destinations. Reims has no supported reviewed river intersection. Nearest-region substitution is not acceptable. |

The PR does not activate these unsupported integrations or claim increased warning coverage. The manifest retains disabled runtime behavior until contracts and representative fixtures pass review.
