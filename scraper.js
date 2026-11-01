const axios = require('axios');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ===== Config =====
const BASE = 'https://www.plusportals.com';
const LOGIN_URL = `${BASE}/VillageSchool`;
const MARKING_PERIOD_ID = 132;      // fallback only; the current term is detected automatically
const SCORE_ID_FIELD = 'sectionId'; // switch to 'courseId' if 9333 turns out to be a CourseId
const DASHBOARD_UID = '';           // Firebase Auth UID; empty = old users/<email prefix> path
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
const rowsOf = d => (Array.isArray(d) ? d : Array.isArray(d?.Data) ? d.Data : []);

function expectJson(res, label) {
  const type = res.headers['content-type'] || '';
  if (res.status !== 200 || !type.includes('json')) {
    throw new Error(`${label}: status ${res.status}, content-type ${type || 'none'} (expected JSON)`);
  }
  return res.data;
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

// ---------- Grades ----------

async function fetchAssignments(session, id) {
  // These two page loads tell the server which class the scores grid is for
  await view(session, `/ParentStudentDetails/ShowScoresIndex?SelectedCourseID=${id}&groupId=0`);
  const details = await view(session, `/ParentStudentDetails/ShowScoresDetails?sectionId=${id}&sectionType=N`);
  const rows = rowsOf(expectJson(
    await api(session, { path: '/ParentStudentDetails/ShowScoresGridInfo', data: 'sort=&group=&filter=' }),
    'ShowScoresGridInfo'
  ));
  const html = String(details.data);
  return {
    rows,
    detailsKb: Math.round(html.length / 1024),
    detailsTableRows: (html.match(/<tr\b/gi) || []).length,
  };
}

async function fetchGrades(session) {
  console.log('Step 3: marking periods');
  const periods = rowsOf(expectJson(
    await api(session, { method: 'get', path: '/ParentStudentDetails/GetMarkingPeriod' }),
    'GetMarkingPeriod'
  ));
  const current = periods.find(p => isTrue(p.isCurrentmarkingPeriod))
    || periods.find(p => p.MarkingPeriodId === MARKING_PERIOD_ID);
  if (!current) throw new Error('Could not determine the current marking period.');
  console.log(`  ${periods.length} periods, current: ${current.MarkingPeriodName} (${current.MarkingPeriodId})`);

  console.log('Step 4: class grades');
  const rows = rowsOf(expectJson(await api(session, {
    path: `/ParentStudentDetails/ShowGridProgressInfo?markingPeriodId=${current.MarkingPeriodId}`,
    data: 'sort=&group=&filter=',
  }), 'ShowGridProgressInfo'));

  const classes = rows
    .filter(r => !isTrue(r.IsWithdrawnCourse))
    .map(r => ({
      courseId: r.CourseId ?? null,
      sectionId: r.SectionId ?? null,
      name: r.CourseName ?? null,
      average: r.Average ?? null,
      grade: r.GradeSymbol ?? null,
      teacher: r.StaffName ?? null,
      teacherEmail: r.StaffEmailId ?? null,
    }));
  console.log(`  ${classes.length} active classes (${rows.length - classes.length} withdrawn skipped)`);
  if (!classes.length) throw new Error('No classes returned for the current marking period.');

  console.log('Step 5: assignment scores');
  let loggedFields = false;
  for (const [i, cls] of classes.entries()) {
    const label = `class ${i + 1} (section ${cls.sectionId}, course ${cls.courseId})`;
    try {
      const { rows: scores, detailsKb, detailsTableRows } = await fetchAssignments(session, cls[SCORE_ID_FIELD]);
      cls.assignments = scores;
      console.log(`  ${label}: ${scores.length} scores | details page ${detailsKb} KB, ${detailsTableRows} <tr>`);
      if (scores.length && !loggedFields) {
        console.log(`  score fields: ${Object.keys(scores[0]).join(', ')}`);
        loggedFields = true;
      }
    } catch (e) {
      cls.assignments = [];
      console.log(`  ${label}: failed — ${e.message}`);
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

// ---------- Main ----------

async function runScraper() {
  try {
    const session = await login();
    const grades = await fetchGrades(session);

    console.log('Step 6: push to Firestore');
    const userId = DASHBOARD_UID || process.env.PLUSPORTALS_USER.split('@')[0];
    await db.collection('users').doc(userId).collection('grades').doc('current').set({
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      ...grades,
    });
    console.log('Successfully updated dashboard data.');
  } catch (error) {
    console.error('Extraction Error:', error.message);
    process.exit(1);
  }
}

runScraper();
