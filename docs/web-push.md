# Hawaya Web Push and account recovery

The student and supervisor apps each have a notification bell. Enabling it is
an explicit per-device action. The browser permission prompt is never shown
automatically at login. iPhone/iPad users must open the installed Home Screen
app before enabling notifications.

Signed-in users who have not enabled notifications on their current device see
the in-app reminder on each launch and each return from the background. Later
dismisses it for the current visit only; navigating pages or refreshing a session
does not reopen it. Enabled devices do not see reminders. Permission is still
requested only after pressing Enable. Blocked browsers and iPhone/iPad users
outside the Home Screen app see the relevant settings or installation guidance.

Delivery rules:
- Students: changes to their own points, new public posts in their stage, and
  new messages in their current group.
- Supervisors: new public posts and group messages across all stages.
- Social authors do not receive notifications for their own posts. Likes,
  edits, pinning and deletion do not create notifications.
- Notification clicks open the relevant points page, stage or group. Lock
  screen text does not contain names, balances or message bodies.

## Server

`hawaya-push` is an isolated Edge Function with gateway JWT verification and
the application's existing student/supervisor authentication. It uses
`web-push@3.6.7` to encrypt Web Push payloads. The main API and social API are
unchanged by this feature.

VAPID credentials are generated inside the function on the first
`getPushConfig` request and kept in `app_private.push_config`. The client gets
only the public key. Keep the same VAPID pair across deployments. The cron
dispatcher uses a separate random private worker credential.

Database triggers enqueue events after message/points writes. `pg_net`
wakes the worker after commit; `pg_cron` retries once a minute. Work is leased,
retried with backoff and expires. Invalid or expired endpoints are removed.
Authorization is checked both while enqueueing and before delivery, including
current group membership, student stage, stage enablement and supervisor
session expiry. Browser roles cannot invoke the push RPCs or read push tables.
Those private tables intentionally have RLS enabled with no browser policies.
See [the Supabase advisory explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

Subscriptions expire after 45 days and refresh on app login if already enabled.
Logout revokes the device subscription and suppresses late deliveries locally.
A student password change also revokes that student's subscriptions. Only an
opaque binding/device capability is kept in the worker's IndexedDB storage;
application login credentials are not copied there.

## Account recovery

Student ID verification now accepts numeric leading-zero variants and Arabic
digits while preserving exact-account precedence. Inactive or wrong-password
exact matches never fall through to another account. The change does not
rewrite existing IDs or passwords.

Supervisor registration uses a local copy of QRCode.js, supports continuing if
the optional QR renderer cannot load, and redirects expired supervisor sessions
to login while preserving entered registration details. These cover observed
failure paths; the user's exact registration failure was not reproduced on
their device.

## Validation and release

Run `npm ci --prefix tests` then `npm test --prefix tests` on Node 24. The suite
uses only synthetic identities and in-memory PGlite databases. It covers
delivery routing, session revocation, encrypted provider requests, device
ownership, retry behavior, browser permission flow, deep links, padded student
IDs and registration recovery. All 48 original checks passed before deployment;
the reminder update adds focused browser lifecycle checks for both app roles.

Production migrations applied on 2026-10-17:
- `20261017143507_normalize_student_login_codes.sql`
- `20261017144043_add_hawaya_web_push.sql`

`hawaya-push` version 1 was deployed with JWT verification enabled. Production
checks confirmed five triggers, the active one-minute cron job, and service-only
RPC privileges. No test students, posts or point changes were created in
production. Final real-device delivery and real-account login were not tested;
the execution environment blocked the direct network/account checks.

Deploy database migration and Edge Function before the frontend. The frontend
initializes the VAPID configuration when the first user enables notifications.
For an operational pause, set `app_private.push_config.enabled` to false through
an authorized server/admin workflow; do not rotate credentials unnecessarily.
