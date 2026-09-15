# Pulse date-range design

## Approved scope

Add a shared time filter to Pulse Overview, persist it in the URL, calculate
statistics from stored authorized activity on the server, and explain historical
coverage. Provide matching detail navigation. The product remains an automatic
shipping journal and team signal wall.

Comparison with previous periods, shipping summaries, Delivery range selection,
and new recognition mechanics are future work.

## Range contract

Presets: Today, Last 7 days (default), Last 30 days, This month, and Custom.
All dates are UTC calendar dates. Last 7 days includes today and the six preceding
dates; Last 30 days includes today and the 29 preceding dates. Custom dates include
both dates shown in the picker. Internally use `start <= occurred_at < end`, with
end at midnight after the selected last day. Ignore future events, even when today
is included. Bound a single request to 366 calendar days. Reject impossible dates,
reversed dates, future end dates, and ranges exceeding that limit with a helpful
400 response. UI validation uses the same shared parser.

Use `period=today|7d|30d|month|custom` on Pulse URLs and `from=YYYY-MM-DD` and
`to=YYYY-MM-DD` for custom dates. Omit the default preset from canonical URLs.
Only Apply commits custom edits; browser back/forward restores the chosen range.
Presets roll forward at the next UTC day; custom dates stay fixed. Existing feed
24h/7d/30d links retain their existing rolling-window behavior. Pulse drill-down
uses explicit from/to dates so it does not silently become a rolling window.

## Overview behavior

Place the filter above Overview. Replace today's summary with the selected-range
contribution total and merge/review/release counts. Chart and repository totals
use that same range. Up to 31 days show daily buckets; longer ranges use Monday
UTC week buckets clipped to the selected range. Empty buckets show zero.

Clicking a chart bucket opens its exact dates in the feed. Clicking a repository
summary opens the feed with that repository and the selected dates. Existing
repository detail panels keep their own explicit time labels.

The hour/day live strip stays visibly labeled as live. Weekly milestones and
leaderboard retain their existing rules and labels. Review Radar, deployment
status and Service Health remain current-state views. Delivery retains its
existing 30-day window. Selecting history never triggers celebrations or alters
the live observation baseline.

## API and storage

Introduce a dedicated overview module and response contract rather than expanding
the existing bounded live snapshot. Expose authenticated workspace overview and
range-activity endpoints, plus equivalent read-only dashboard-share endpoints.
The overview response includes normalized dates, bucket granularity, counts,
repository summaries, generatedAt, and coverage metadata. Activity responses
include events and an opaque next cursor. Use descending occurred_at/event_id
keyset pagination, at most 100 events per page, and a stable request cutoff.
Cursors bind to the range and repository filter and cannot grant access.

Aggregate stored events in PostgreSQL for the entire requested range. Do not
apply FEED_LIMIT before aggregation, fetch all events into Node, or change the
existing live feed limit. Preserve existing human-actor, note-exclusion and
contribution counting semantics; this API does not redefine XP. Validate parity
with the existing activity helpers using fixtures. All dates and repository IDs
are parameterized SQL inputs. Review query plans before introducing any index;
use the next available migration number if an index is required.

Authorization is checked before querying and again before returning. Restrict
queries to the authorized installation and repository IDs. If access changes
during a query, discard its aggregates and fail closed rather than returning
totals that include removed repositories. Shared requests use the intersection
of the link's pinned repository IDs and its creator's current access; respect
expiry, rotation and revocation. Never include personal notes in these endpoints.

## Coverage and refresh

State explicitly that totals describe stored activity visible to this viewer.
GitHub history imports are bounded and push history begins with webhooks; the
oldest observed event is not proof of complete coverage. Expose earliest stored
activity in the authorized scope and configured retention when available, but
never call this a guaranteed complete archive. Empty ranges say no stored
activity, not no work happened. Distinguish load failures from empty results.

Abort superseded requests and ignore stale responses on range/workspace changes.
Clear private results on logout or access failure. Revalidate on existing live
snapshot notifications with coalescing; do not create a separate event stream.
Request metadata and rendered values must belong to the same selected range.
Demo uses the same range/aggregation semantics locally and identifies its data
as fictional. Shared dashboards support the picker without widening link scope.

## Verification

- Shared date tests: leap dates, invalid dates, UTC boundaries, inclusive last
  day, Monday buckets, default serialization and browser navigation.
- PostgreSQL tests: more than 2,000 matching events, unauthorized repositories,
  other installations, bot/note filtering, empty buckets, exact boundaries and
  equal-timestamp pagination without duplicates or gaps.
- API tests: access removed during query, revoked/expired/rotated share,
  malformed ranges/cursors, and personal-note exclusion.
- UI tests: presets/custom Apply, loading/error/empty states, drill-down dates,
  stale request suppression, workspace changes and historical views remaining
  silent while live recognition retains its weekly semantics.
- Browser checks: desktop/mobile picker, keyboard labels, chart readability,
  back/forward and read-only sharing. Run npm test, database suite, npm run build,
  and formatting checks; report any environment-dependent checks not executed.

## Delivery boundary

Implement in this task after written-design review. Keep existing unrelated
untracked files intact. Production deployment and publishing are outside this
approved implementation scope.
