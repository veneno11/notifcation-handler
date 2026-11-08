const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { syncLifeOS } = require('./lifeos');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ===== Config =====
const BASE = 'https://www.plusportals.com';
const LOGIN_URL = `${BASE}/VillageSchool`;
const STUDENT_ID = 12136;
const MARKING_PERIOD_ID = 132;      // fallback only; the current term is detected automatically
const SCORE_ID_FIELD = 'sectionId'; // confirmed: section 9333 matched your capture
const DASHBOARD_UID = 'NDfVp3jlO1SCqjvx6dPwYOUsAym1';// your Firebase Auth UID (the dashboard shows it with a copy button)
const DASHBOARD_URL = 'https://veneno11.github.io/personalApi/'; // opened when you tap a notification
// ==================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// ---------- Cookie jar & HTTP ----------

// _pps=-360 was in your browser (looks like your UTC-6 offset); harmless to send.
const jar = new Map([['_pps', '-360']]);

function storeCookies(res) {
  for (const c of res.headers['set-cookie'] || []) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value) jar.set(name, value); else jar.delete(name);
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const cookieNames = () => [...jar.keys()].join(', ') || 'none';

const http = axios.create({
  maxRedirects: 0,              // handle redirects ourselves so Set-Cookie isn't lost
  validateStatus: s => s < 500,
  headers: { 'User-Agent': UA },
});

async function request(config) {
  const res = await http({ ...config, headers: { ...(config.headers || {}), Cookie: cookieHeader() } });
  storeCookies(res);
  return res;
}

async function follow(res, hops = 5) {
  while ([301, 302, 303, 307, 308].includes(res.status) && hops-- > 0) {
    const next = new URL(res.headers.location, BASE);
    console.log(`  -> ${res.status} redirect to ${next.pathname}`);
    res = await request({ method: 'get', url: next.toString() });
  }
  return res;
}

// ---------- Helpers ----------

function extractToken(html) {
  const input = String(html).match(/<input[^>]*name="__RequestVerificationToken"[^>]*>/i);
  return input ? (input[0].match(/value="([^"]*)"/i) || [])[1] : null;
}

const isTrue = v => String(v).toLowerCase() === 'true';

// Grid responses come as a bare array, { Data: [...] }, or { dataResult: { Data: [...] } }
const rowsOf = d =>
  Array.isArray(d) ? d
  : Array.isArray(d?.Data) ? d.Data
  : Array.isArray(d?.dataResult?.Data) ? d.dataResult.Data
  : [];

function expectJson(res, label) {
  const type = res.headers['content-type'] || '';
  if (res.status !== 200 || !type.includes('json')) {
    throw new Error(`${label}: status ${res.status}, content-type ${type || 'none'} (expected JSON)`);
  }
  return res.data;
}

// Firestore rejects arrays directly inside arrays; wrap any it finds
function firestoreSafe(v, inArray = false) {
  if (Array.isArray(v)) {
    const arr = v.map(x => firestoreSafe(x, true));
    return inArray ? { items: arr } : arr;
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, firestoreSafe(x)]));
  }
  return v === undefined ? null : v;
}

// Plain text for notification messages (teacher text can contain HTML)
const cleanText = s => String(s ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

const fmtNum = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? String(+n.toFixed(2)) : String(v ?? '');
};

// PlusPortals dates are calendar days; format them without timezone shifts
function dayText(v) {
  const s = String(v ?? '');
  let d = null;
  const ms = s.match(/\/Date\((-?\d+)/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (ms) {
    const t = new Date(Number(ms[1]));
    d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  } else if (iso) {
    d = new Date(Date.UTC(+iso[1], iso[2] - 1, +iso[3]));
  } else if (us) {
    d = new Date(Date.UTC(+us[3], us[1] - 1, +us[2]));
  }
  return d ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
}

// JSON/grid requests (need the anti-forgery header)
function api(session, { method = 'post', path, data }) {
  return request({
    method,
    url: BASE + path,
    data,
    headers: {
      '__RequestVerificationToken': session.apiToken,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Origin: BASE,
      Referer: session.referer,
      ...(data != null ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
    },
  });
}

// HTML partial-view requests
function view(session, path) {
  const sep = path.includes('?') ? '&' : '?';
  return request({
    method: 'get',
    url: `${BASE}${path}${sep}_=${Date.now()}`,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html, */*; q=0.01',
      Referer: session.referer,
    },
  });
}

// ---------- Login ----------

async function login() {
  console.log('Step 1: GET login page');
  const page = await follow(await request({ method: 'get', url: LOGIN_URL }));
  const formToken = extractToken(page.data);
  console.log(`  status ${page.status}, token ${formToken ? 'found' : 'NOT found'}, cookies: ${cookieNames()}`);
  if (page.status !== 200) throw new Error(`Login page returned ${page.status}`);

  const form = new URLSearchParams({
    UserName: process.env.PLUSPORTALS_USER,
    Password: process.env.PLUSPORTALS_PASS,
    RememberMe: 'false',
    btnsumit: 'Sign In',
  });
  if (formToken) form.append('__RequestVerificationToken', formToken);

  console.log('Step 2: POST credentials');
  const res = await request({
    method: 'post',
    url: LOGIN_URL,
    data: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Referer: LOGIN_URL },
  });
  const loc = res.headers.location ? new URL(res.headers.location, BASE).pathname : 'none';
  console.log(`  status ${res.status}, redirect: ${loc}`);

  // The auth cookie is issued further down the redirect chain, so follow it first
  let home = await follow(res);
  console.log(`  landed on ${new URL(home.config.url).pathname} (status ${home.status}), cookies: ${cookieNames()}`);

  // If we stopped on an intermediate page (e.g. a JavaScript redirect), find the student-page link in it
  if (!/\/ParentStudentDetails\//i.test(new URL(home.config.url).pathname)) {
    const html = String(home.data);
    const link = html.match(/\/ParentStudentDetails\/ParentStudentDetails(\?op=[^"'\s<>]+)?/i);
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1];
    console.log(`  not on student page yet (title: ${title ? title.trim() : 'none'}), student link ${link ? 'found' : 'NOT found'}`);
    if (link) {
      home = await follow(await request({ method: 'get', url: BASE + link[0].replace(/&amp;/g, '&') }));
      console.log(`  now on ${new URL(home.config.url).pathname} (status ${home.status}), cookies: ${cookieNames()}`);
    }
  }

  if (!jar.has('.ASPXAUTH')) throw new Error('No .ASPXAUTH cookie after following redirects.');
  if (!/\/ParentStudentDetails\//i.test(new URL(home.config.url).pathname)) {
    throw new Error('Logged in, but never reached the student page.');
  }

  const apiToken = extractToken(home.data);
  console.log(`  API token ${apiToken ? 'found' : 'NOT found'}`);
  if (!apiToken) throw new Error('No anti-forgery token on the student page.');
  return { apiToken, referer: home.config.url };
}

// ---------- Upcoming coursework ----------

async function fetchUpcoming(session) {
  console.log('Step 3: upcoming coursework');
  try {
    const body = new URLSearchParams({
      sort: '', page: '1', pageSize: '50', group: '', filter: '',
      studentId: String(STUDENT_ID), sectionId: '0', courseworkRange: '1',
      courseworkType: 'All Types', token: '',
    });
    const res = expectJson(await api(session, {
      path: '/ParentStudentDetails/GetCourseworkDetailsByStudent',
      data: body.toString(),
    }), 'GetCourseworkDetailsByStudent');

    const items = rowsOf(res);
    const total = res?.dataResult?.Total ?? items.length;
    console.log(`  ${items.length} items (total ${total}), past due: ${res?.pastDueCount ?? 'n/a'}`);
    return { ok: true, items, total, pastDueCount: res?.pastDueCount ?? null };
  } catch (e) {
    console.log(`  failed — ${e.message}`);
    return { ok: false, items: [], total: 0, pastDueCount: null };
  }
}

// ---------- Grades ----------

async function fetchAssignments(session, id) {
  // These two page loads tell the server which class the scores grid is for
  await view(session, `/ParentStudentDetails/ShowScoresIndex?SelectedCourseID=${id}&groupId=0`);
  await view(session, `/ParentStudentDetails/ShowScoresDetails?sectionId=${id}&sectionType=N`);
  return rowsOf(expectJson(
    await api(session, { path: '/ParentStudentDetails/ShowScoresGridInfo', data: 'sort=&group=&filter=' }),
    'ShowScoresGridInfo'
  ));
}

async function fetchGrades(session) {
  console.log('Step 4: marking periods');
  const periods = rowsOf(expectJson(
    await api(session, { method: 'get', path: '/ParentStudentDetails/GetMarkingPeriod' }),
    'GetMarkingPeriod'
  ));
  const current = periods.find(p => isTrue(p.isCurrentmarkingPeriod))
    || periods.find(p => p.MarkingPeriodId === MARKING_PERIOD_ID);
  if (!current) throw new Error('Could not determine the current marking period.');
  console.log(`  ${periods.length} periods, current: ${current.MarkingPeriodName} (${current.MarkingPeriodId})`);

  console.log('Step 5: class grades');
  const rows = rowsOf(expectJson(await api(session, {
    path: `/ParentStudentDetails/ShowGridProgressInfo?markingPeriodId=${current.MarkingPeriodId}`,
    data: 'sort=&group=&filter=',
  }), 'ShowGridProgressInfo'));

  const classes = rows
    .filter(r => !isTrue(r.IsWithdrawnCourse))
    .map(r => ({
      sectionId: r.SectionId ?? null,
      name: r.CourseName ?? null,
      average: r.Average ?? null,
      grade: r.GradeSymbol ?? null,
      teacher: r.StaffName ?? null,
      teacherEmail: r.StaffEmailId ?? null,
    }));
  console.log(`  ${classes.length} active classes (${rows.length - classes.length} withdrawn skipped)`);
  if (!classes.length) throw new Error('No classes returned for the current marking period.');

  console.log('Step 6: assignment scores');
  for (const [i, cls] of classes.entries()) {
    const label = `class ${i + 1} (section ${cls.sectionId})`;
    try {
      cls.assignments = await fetchAssignments(session, cls[SCORE_ID_FIELD]);
      console.log(`  ${label}: ${cls.assignments.length} scores`);
    } catch (e) {
      cls.assignments = null; // filled from the last run below
      console.log(`  ${label}: failed — ${e.message} (keeping last run's scores)`);
    }
  }

  return {
    markingPeriod: {
      id: current.MarkingPeriodId,
      name: current.MarkingPeriodName,
      description: current.Description ?? null,
    },
    markingPeriods: periods.map(p => ({
      id: p.MarkingPeriodId,
      name: p.MarkingPeriodName,
      description: p.Description ?? null,
      current: isTrue(p.isCurrentmarkingPeriod),
    })),
    classes,
  };
}

// ---------- New-item tracking ----------

// If part of this run failed, keep the last run's copy instead of wiping it
function reuseOnFailure(grades, upcoming, prev) {
  for (const cls of grades.classes) {
    if (cls.assignments !== null) continue;
    const old = (prev?.classes || []).find(c => c.sectionId === cls.sectionId);
    cls.assignments = old?.assignments || [];
  }
  if (upcoming.ok || !prev?.upcoming) return upcoming;
  console.log("  upcoming fetch failed: keeping last run's list");
  return { ...prev.upcoming, ok: true };
}

const itemKey = (prefix, parts) =>
  prefix + crypto.createHash('sha1').update(parts.map(p => String(p ?? '')).join('|')).digest('hex').slice(0, 16);
const hasScore = a => a.Score !== null && a.Score !== undefined && String(a.Score).trim() !== '';

function trackNew(grades, upcoming, prev) {
  const prevSeen = prev?.seen || {};
  const baseline = !prev?.seen; // first tracked run: record everything, alert nothing
  const now = Date.now();
  const seen = {};
  const fresh = { assignments: [], grades: [] };

  const mark = (item, key, bucket, info) => {
    if (key in seen) { item.firstSeen = seen[key]; return; }
    const isNew = !(key in prevSeen);
    const first = isNew ? (baseline ? 0 : now) : prevSeen[key];
    seen[key] = first;
    item.firstSeen = first;
    if (isNew && !baseline) fresh[bucket].push(info);
  };

  for (const it of upcoming.items || []) {
    mark(it, itemKey('u', [it.AssignmentID, it.LessonActivityID, it.DiscussionTopicID, it.SectionID, it.Title, it.DueDate]), 'assignments', {
      title: cleanText(it.Title) || 'Untitled',
      course: cleanText(it.CourseName || it.Class),
      due: it.DueDate,
    });
  }
  for (const cls of grades.classes) {
    for (const a of cls.assignments || []) {
      if (!hasScore(a)) continue;
      mark(a, itemKey('g', [cls.sectionId, a.ShortName, a.Description, a.AssignmentDate, a.Score]), 'grades', {
        title: cleanText(a.Description) || cleanText(a.ShortName) || 'Assignment',
        course: cleanText(cls.name),
        score: a.Score,
        possible: a.PossiblePoints,
      });
    }
  }
  return { seen, fresh, baseline };
}

// ---------- Notifications ----------

function buildMessages({ assignments: A, grades: G }) {
  const list = lines => lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n+${lines.length - 4} more` : '');
  const scoreText = g => `${fmtNum(g.score)}${g.possible != null && g.possible !== '' ? `/${fmtNum(g.possible)}` : ''}`;
  const out = [];

  if (A.length === 1) {
    const due = dayText(A[0].due);
    out.push({ title: `New assignment · ${A[0].course || 'PlusPortals'}`, body: `${A[0].title}${due ? ` — due ${due}` : ''}` });
  } else if (A.length > 1) {
    out.push({ title: `${A.length} new assignments`, body: list(A.map(a => (a.course ? `${a.course}: ${a.title}` : a.title))) });
  }

  if (G.length === 1) {
    out.push({ title: `New grade · ${G[0].course || 'PlusPortals'}`, body: `${G[0].title}: ${scoreText(G[0])}` });
  } else if (G.length > 1) {
    out.push({ title: `${G.length} new grades`, body: list(G.map(g => `${g.course ? `${g.course}: ` : ''}${g.title} — ${scoreText(g)}`)) });
  }
  return out;
}

async function sendNotifications(userRef, fresh) {
  const messages = buildMessages(fresh);
  if (!messages.length) { console.log('  nothing new'); return; }

  const snap = await userRef.collection('devices').get();
  const devices = snap.docs.filter(d => typeof d.get('token') === 'string');
  if (!devices.length) { console.log('  no devices registered (turn notifications on in the dashboard)'); return; }

  const tokens = devices.map(d => d.get('token'));
  const expired = new Set();
  let sent = 0;

  for (const m of messages) {
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: m.title, body: m.body },
      webpush: { fcmOptions: { link: DASHBOARD_URL } },
    });
    sent += res.successCount;
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code || '';
      console.log(`  device ${i + 1}: ${code || r.error?.message}`);
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        expired.add(devices[i].ref);
      }
    });
  }

 await Promise.all([...expired].map(ref => ref.delete()));
  console.log(`  sent ${sent} notification(s) to ${tokens.length} device(s)${expired.size ? `, removed ${expired.size} expired` : ''}`);
}

// ---------- Leo's LifeOS: send each assignment once ----------
// Remembers every assignment already sent to LifeOS (in LifeOS's Firestore), so
// each one is added and notified once, even after you mark it done or delete it.
// Overdue ones are skipped. An entry is forgotten 10 days after it was first
// seen, once it's past due (overdue ones are skipped, so it can't come back).

// PlusPortals due date -> YYYY-MM-DD (same day logic as dayText above)
function isoDay(v) {
  const s = String(v ?? '');
  const ms = s.match(/\/Date\((-?\d+)/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return '';
}

async function onlyNewForLifeOS(items) {
  const TZ = 'America/Chicago';
  const dayISO = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const today = dayISO(Date.now());
  const forgetBefore = dayISO(Date.now() - 10 * 864e5);

  const lifeos = admin.initializeApp(
    { credential: admin.credential.cert(JSON.parse(process.env.LIFEOS_SERVICE_ACCOUNT)) }, 'lifeos-log'
  );
  const ref = lifeos.firestore().doc('artifacts/leo-lifeos-local/users/leo-main-sync-account/appData/plusportalsLog');

  const snap = await ref.get();
  const firstRun = !snap.exists;
  const log = (snap.exists && snap.data().seen) || {};
  for (const [key, e] of Object.entries(log)) {
    if (e.seen < forgetBefore && e.due < today) delete log[key];
  }

  const fresh = [];
  for (const it of items) {
    const key = itemKey('u', [it.AssignmentID, it.LessonActivityID, it.DiscussionTopicID, it.SectionID, it.Title, it.DueDate]);
    const due = isoDay(it.DueDate);
    if (log[key] || (due && due < today)) continue; // already sent, or overdue
    log[key] = { seen: today, due: due || '9999-12-31' };
    if (!firstRun) fresh.push(it);
  }

  await ref.set({ seen: log, updatedAt: new Date().toISOString() });
  console.log(firstRun
    ? `  first run: remembered ${Object.keys(log).length} assignments, nothing re-sent`
    : `  ${fresh.length} new for LifeOS`);
  return fresh;
}

// ---------- Main ----------

async function runScraper() {
  try {
    const session = await login();
    let upcoming = await fetchUpcoming(session); // before the class loop changes the selected class
    const grades = await fetchGrades(session);

    const userId = DASHBOARD_UID || process.env.PLUSPORTALS_USER.split('@')[0];
    const userRef = db.collection('users').doc(userId);
    const docRef = userRef.collection('grades').doc('current');

    console.log('Step 7: compare with last run');
    const prevSnap = await docRef.get();
    const prev = prevSnap.exists ? prevSnap.data() : null;
    upcoming = reuseOnFailure(grades, upcoming, prev);
    const { seen, fresh, baseline } = trackNew(grades, upcoming, prev);
    console.log(baseline
      ? '  first tracked run: saving a baseline, no alerts this time'
      : `  ${fresh.assignments.length} new assignments, ${fresh.grades.length} new grades`);

    console.log('Step 8: push to Firestore');
    const { ok, ...upcomingData } = upcoming;
    await docRef.set({
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      ...firestoreSafe({ ...grades, upcoming: upcomingData, seen }),
    });
    console.log('  saved');

    console.log('Step 9: notifications');
    try {
      await sendNotifications(userRef, fresh);
    } catch (e) {
      console.log(`  failed — ${e.message}`);
    }
console.log("Step 10: Leo's LifeOS");
    try {
const newItems = await onlyNewForLifeOS(upcoming.items || []);
      if (newItems.length) await syncLifeOS(newItems);
      else console.log('  nothing new for LifeOS');
    } catch (e) {
      console.log(`  failed — ${e.message}`);
    }
    
    console.log('Done.');
    process.exit(0);
  } catch (error) {
    console.error('Extraction Error:', error.message);
    process.exit(1);
  }
}

runScraper();
