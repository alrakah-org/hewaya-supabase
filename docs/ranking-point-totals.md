# Complete ranking totals

Student balances, student group rankings, supervisor rankings and chart exports
include the same three sources: point awards, attendance points and supervisor
transactions (including negative adjustments). Selecting a week applies the
existing week-number filters and attendance-date range to all pages.

Previously, each ledger query read only one PostgREST response. A batch across
students could exceed the server row limit and silently omit awards, while a
single-student query still returned all of that student's entries. This made
supervisor and student totals disagree. Manual adjustments were already included.

`pointRows` now reads each ledger in ascending primary-key order, keeping the
student and period filters on every page. It continues until an empty response,
including when the server returns fewer than the requested 1,000 records. Failed
pages reject the whole result instead of publishing an incomplete ranking.
The same reader covers ranking details and point history. Student group and
login-rank calculations share the batch balance calculation.

No point records are rewritten. Existing deployed stage-content routes are
preserved in the repository and deployment.

## Verification

Run `node --test tests/ranking-points.test.cjs tests/point-stages.test.cjs`.
The synthetic regression fixture contains 1,534 awards and reproduces the
truncation against the old deployed source. Tests also cover more than 1,000
attendance records and manual transactions, negative adjustments, weekly filters,
smaller server limits, failed later pages, login ranking and authentication.

After deployment, confirm the API version is `complete-ranking-points-20261028`
and compare selected live leaderboard values with direct sums from all three
ledgers. Reopen rankings and regenerate earlier chart downloads to show the
complete totals.
