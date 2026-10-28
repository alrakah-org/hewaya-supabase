const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { webcrypto } = require('node:crypto');

const source = stripTypeScriptTypes(fs.readFileSync(process.env.HAWAYA_API_SOURCE || __dirname + '/../supabase/functions/hawaya-api/index.ts', 'utf8'));

function setup({ cap = 1000, failAfterFirstPage = false } = {}) {
  const students = [1, 2, 3, 4].map(id => ({ id, student_code: 'student-' + id, full_name: 'طالب تجريبي ' + id, grade: id === 4 ? 'أول ثانوي' : 'ثاني متوسط', active: true }));
  const groups = [{ id: 'middle-group', name: 'مجموعة المتوسط', stage_category: 'middle', active: true }, { id: 'secondary-group', name: 'مجموعة الثانوي', stage_category: 'secondary', active: true }];
  const memberships = students.map(s => ({ group_id: s.id === 4 ? 'secondary-group' : 'middle-group', student_id: s.id, students: s, left_at: null }));
  const awards = Array.from({ length: 1534 }, (_, i) => ({ id: i + 1, student_id: 4, total_points: 1, quantity: 1, week_number: 7, activity_date: '2026-10-12', created_at: '2026-10-12T12:00:00Z', point_items: { name: 'إنجاز' } }));
  [14700, 9300, 10500].forEach((points, i) => Object.assign(awards[i], { student_id: i + 1, total_points: points, quantity: 2 }));
  [12700, 10400, 8600].forEach((points, i) => Object.assign(awards[1000 + i], { student_id: i + 1, total_points: points, quantity: 3, week_number: 8, activity_date: '2026-10-19' }));
  const transactions = [13300, 18300, 11300].map((amount, i) => ({ id: i + 1, student_id: i + 1, amount, reason: 'تعديل يدوي', week_number: 7, activity_date: '2026-10-12', created_at: '2026-10-12T13:00:00Z' }));
  const attendance = [2700, 1000, 600].map((points, i) => ({ id: i + 1, student_id: i + 1, points, attendance_type: 'early', attendance_date: '2026-10-12', created_at: '2026-10-12T14:00:00Z' }));
  const tables = { students, groups, group_memberships: memberships, point_awards: awards, point_transactions: transactions, attendance };
  const calls = [], errors = []; let handler;
  const fetch = async (url, options = {}) => {
    const u = new URL(url), table = u.pathname.split('/').pop(), q = u.searchParams;
    calls.push({ table, query: Object.fromEntries(q), method: options.method || 'GET' });
    if (u.pathname.includes('/rpc/')) {
      const p = JSON.parse(options.body);
      if (table === 'edge_student_verify') return Response.json(p.p_password === 'test-password' ? students.find(s => s.student_code === p.p_code)?.id || null : null);
      if (table === 'edge_supervisor_session') return Response.json([{ supervisor_name: 'مشرف تجريبي' }]);
    }
    if ((options.method || 'GET') !== 'GET') throw new Error('Unexpected database write');
    if (failAfterFirstPage && table === 'point_awards' && Number(q.get('id')?.slice(3)) >= 1000) return Response.json({ message: 'Test failure on later page' }, { status: 500 });
    let data = (tables[table] || []).slice();
    for (const [key, value] of q) {
      if (value.startsWith('eq.')) data = data.filter(r => String(r[key]) === value.slice(3));
      else if (value.startsWith('in.(')) { const values = value.slice(4, -1).split(','); data = data.filter(r => values.includes(String(r[key]))); }
      else if (value === 'is.null') data = data.filter(r => r[key] == null);
      else if (value.startsWith('gt.')) data = data.filter(r => Number(r[key]) > Number(value.slice(3)));
      else if (value.startsWith('gte.')) data = data.filter(r => String(r[key]) >= value.slice(4));
      else if (value.startsWith('lte.')) data = data.filter(r => String(r[key]) <= value.slice(4));
    }
    if (q.get('order') === 'id.asc') data.sort((a, b) => a.id - b.id);
    const limit = Math.min(cap, Number(q.get('limit') || cap));
    return Response.json(data.slice(0, limit));
  };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-28T18:00:00Z'])); } static now() { return Date.parse('2026-10-28T18:00:00Z'); } }
  vm.runInNewContext(source, { Deno: { env: { get: n => n === 'SUPABASE_URL' ? 'https://fixture.test' : 'synthetic-key' }, serve: fn => { handler = fn; } }, fetch, Request, Response, Headers, TextEncoder, crypto: webcrypto, Date: FixedDate, setTimeout: fn => setImmediate(fn), console: { error: e => errors.push(e.message) } });
  return { tables, calls, errors, async call(body, supervisor = true) {
    const response = await handler(new Request('https://fixture.test/functions/v1/hawaya-api', { method: 'POST', headers: supervisor ? { 'x-hawaya-session': 'synthetic-session' } : {}, body: JSON.stringify(body) }));
    return { status: response.status, ...await response.json() };
  } };
}
const ranking = { action: 'getAdvancedRanking', category: 'متوسط', mode: 'individuals', weekNumber: 'all', details: true };
const sums = members => members.map(s => [s.id, s.balance]);

test('all 1534 ledger rows count: supervisor and student totals agree, including manual points', async () => {
  const x = setup();
  const supervisor = await x.call(ranking);
  assert.equal(supervisor.success, true);
  assert.deepEqual(sums(supervisor.columns[0].members), [['student-1', 43400], ['student-2', 39000], ['student-3', 31000]]);
  assert.equal(supervisor.columns[0].totalPoints, 113400);
  const student = await x.call({ action: 'getStudentGroupData', id: 'student-1', password: 'test-password' }, false);
  assert.deepEqual(sums(student.group.members), sums(supervisor.columns[0].members));
  for (const member of supervisor.columns[0].members) {
    assert.deepEqual(member.details.items, [{ label: 'إنجاز', count: 5 }, { label: 'حضور مبكر', count: 1 }, { label: 'تعديل يدوي', count: 1 }]);
  }
  assert.ok(x.calls.some(c => c.table === 'point_awards' && c.query.id === 'gt.1000'));
  assert.deepEqual(x.errors, []);
});

test('group totals, login rank and student leaderboard use the same complete ledger', async () => {
  const x = setup();
  const groups = await x.call({ ...ranking, mode: 'groups', groupIds: ['middle-group'] });
  assert.equal(groups.columns.length, 1);
  assert.equal(groups.columns[0].totalPoints, 113400);
  const leaderboard = await x.call({ action: 'getLeaderboard', stage: 'ثاني متوسط' }, false);
  assert.deepEqual(sums(leaderboard.leaderboard), sums(groups.columns[0].members));
  const login = await x.call({ action: 'studentLogin', id: 'student-2', password: 'test-password' }, false);
  assert.equal(login.balance, 39000); assert.equal(login.rank, 2);
});

test('weekly filters survive every page and exclude other weeks and stages', async () => {
  const x = setup({ cap: 5 });
  const result = await x.call({ ...ranking, weekNumber: '8' });
  assert.equal(result.weekNumber, '8');
  assert.deepEqual(sums(result.columns[0].members), [['student-1', 12700], ['student-2', 10400], ['student-3', 8600]]);
  for (const s of result.columns[0].members) assert.deepEqual(s.details.items, [{ label: 'إنجاز', count: 3 }]);
  assert.equal((await x.call({ ...ranking, weekNumber: '999' })).status, 400);
});

test('attendance and manual adjustments beyond 1000 rows, including negative adjustments, are not truncated', async () => {
  const x = setup();
  x.tables.point_awards.length = 0;
  x.tables.point_transactions.splice(0, Infinity, ...Array.from({ length: 1201 }, (_, i) => ({ id: i + 1, student_id: 1, amount: i === 1200 ? -100 : 10, reason: 'تعديل يدوي', week_number: 8 })));
  x.tables.attendance.splice(0, Infinity, ...Array.from({ length: 1002 }, (_, i) => ({ id: i + 1, student_id: 1, points: 100, attendance_type: 'normal', attendance_date: '2026-10-19' })));
  const result = await x.call({ ...ranking, weekNumber: '8' });
  const member = result.columns[0].members[0];
  assert.equal(member.balance, 112100);
  assert.deepEqual(member.details.items, [{ label: 'حضور عادي', count: 1002 }, { label: 'تعديل يدوي', count: 1201 }]);
  const student = await x.call({ action: 'getStudentGroupData', id: 'student-1', password: 'test-password' }, false);
  assert.equal(student.group.members[0].balance, member.balance);
  const log = await x.call({ action: 'getPointsLog', id: 'student-1' });
  assert.equal(log.log.length, 2203);
  assert.equal(log.log.reduce((sum, row) => sum + row.amount, 0), member.balance);
});

test('server limits below the requested page size still return every point entry', async () => {
  const x = setup({ cap: 50 });
  const result = await x.call(ranking);
  assert.equal(result.columns[0].totalPoints, 113400);
  assert.ok(x.calls.some(c => c.table === 'point_awards' && c.query.id === 'gt.1500'));
});

test('a failed later page cannot return a successful partial ranking', async () => {
  const x = setup({ failAfterFirstPage: true });
  const result = await x.call(ranking);
  assert.equal(result.status, 500); assert.equal(result.success, false);
  assert.equal(result.columns, undefined);
});

test('empty ledgers return zero and ranking authentication remains required', async () => {
  const x = setup();
  for (const table of ['point_awards', 'attendance', 'point_transactions']) x.tables[table].length = 0;
  const result = await x.call(ranking);
  assert.equal(result.columns[0].totalPoints, 0);
  assert.equal((await x.call(ranking, false)).status, 401);
  assert.equal((await x.call({ action: 'getStudentGroupData', id: 'student-1', password: 'wrong' }, false)).success, false);
});
