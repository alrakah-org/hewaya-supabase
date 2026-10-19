# Supervisor social loading — 2026-10-17

Recent production social-function logs (18:00–19:20 UTC) contained 61 successful
requests, averaging 1,304 ms and reaching 3,755 ms inside the function. These
include all social actions and are not end-to-end device measurements.

The supervisor overview previously made six database HTTP requests across four
sequential rounds: session, settings/groups, two feeds, then likes. The new
server-only `edge_supervisor_social_overview` RPC returns the same bounded feeds,
groups, settings, likes and avatars in one database HTTP request. The RPC checks
the existing supervisor session on every call, stays `SECURITY INVOKER`, and is
executable only by `service_role`. No browser grants or student routes change.
Existing stage/pin, group and likes indexes cover the bounded queries. CORS
preflight permission can be reused for ten minutes; actual session validation
still happens for every request.

The supervisor app retains session-bound cached feeds for up to seven days and
renders them before awaiting the network. The latest response is saved
immediately; page hide/background events also save the latest selection.
Logout, account changes and authentication failures clear the cache. A fresh
installation still needs its first network read. No old messages are fabricated
when the cache is empty.

Validation: 22 focused checks passed, including an in-memory Postgres exercised
through the actual Edge handler, permission/session rejection, stage/group
isolation, pinned/deleted ordering, the newest-100 chat window, reopen/background
persistence, stale responses and notification deep links. Existing student and
moderation regression checks also pass. Deno type checking passes. Real phone
network latency after deployment has not been measured.

Production rollout: migration `20261017192452_fast_supervisor_social_overview`
was applied on October 17. `hawaya-social` version 5 was deployed on October 19
with JWT verification enabled. Production checks reject invalid sessions and
deny execution to browser roles. A bounded tweet/likes query completed in about
5 ms in Postgres; this is not a measurement of the full API or phone latency.
