# Hosted cost model

TravelCanary uses one Vercel project, two Blob stores, Fluid Compute, and six cron schedules. The application introduces no external database or paid warning-source credential.

The public write unit is one atomic Catalog 3 generation: one Snapshot V11 object, 45 Conditions V3 objects, one immutable manifest, and one pointer CAS. Unchanged content-addressed objects are reused. Maintenance bounds retained generations to the current pointer, one rollback generation, and generations younger than 48 hours.

The conditions cadence republishes all 45 country references as one generation so visitors never observe mixed timestamps. Forecast and observation evidence inside a payload retains its original timestamps; a current manifest does not relabel stale evidence as newly observed.

Primary cost controls are:

- fixed six schedules in `vercel.json`
- one global writer lease, preventing overlapping write amplification
- bounded provider requests, response bytes, records, state, and function duration
- immutable-object reuse
- eight-way bounded publication validation
- 48-hour generation retention plus one rollback
- Preview isolation, which performs no production Blob reads or writes

Operators should monitor Vercel invocation duration, Blob request counts, stored bytes, lease-busy frequency, publication failures, and generation age. Exact prices and plan quotas change over time; use the current Vercel dashboard and pricing documentation rather than hard-coding currency estimates here.
