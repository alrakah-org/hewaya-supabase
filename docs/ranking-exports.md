# Ranking chart downloads

In the supervisor app, open **الترتيب**, select the stage, mode, groups and period,
then press **إظهار الترتيب**. The **تحميل الرسم البياني** panel appears above the
results, offering PDF and Excel downloads.

- Individual mode exports every displayed student, sorted by points descending.
- Group mode exports a comparison of group totals, followed by student rankings
  for each selected group.
- PDF uses A4 landscape pages, Arabic names, point labels, ranks and the Hawaya
  logo. Ten entries appear on each page. The vertical scale remains consistent
  across pages of the same ranking.
- Excel is a real `.xlsx` workbook with numeric points and native editable column
  charts linked to the data cells. It includes one sheet per ranking and one chart
  per ten entries, without truncating the student list.

The exporter is loaded only on the first download. Files are generated locally
from the last successful ranking response; downloading makes no further API
requests. The export excludes account identifiers, passwords and session tokens.
Names are encoded as text cells, never formulas.

Changing filters or logging out invalidates the snapshot. Late ranking responses
cannot replace a newer request. Failed, empty or mismatched-week responses do not
enable downloads. A failed exporter load can be retried.

## Validation

Run `node --test tests/ranking-export.test.cjs
tests/supervisor-social-navigation.test.cjs` with the test dependencies installed.
Coverage includes sorting, 150 students, native chart references, numeric cells,
XML escaping, selected groups, hidden group filters in individual mode, failed
loads, stale responses, week mismatch and logout.

Visual verification should render the PDF and open the XLSX in an Office-compatible
engine. Use synthetic names and points when testing downloads.
