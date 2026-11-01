const axios = require('axios');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ===== Config (from your Network capture) =====
const BASE = 'https://www.plusportals.com';
const LOGIN_URL = `${BASE}/VillageSchool`;
const STUDENT_ID = 12136;
const MARKING_PERIOD_ID = 132; // current term; we'll automate this once we see GetMarkingPeriod's shape
// ==============================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// Minimal cookie jar. _pps=-360 was in your browser (looks like your UTC-6 offset); harmless to send.
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

function extractToken(html) {
  const input = String(html).match(/<input[^>]*name="__RequestVerificationToken"[^>]*>/i);
  return input ? (input[0].match(/value="([^"]*)"/i) || [])[1] : null;
}

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
  console.log(`  status ${res.status}, redirect: ${loc}, cookies: ${cookieNames()}`);
  if (!jar.has('.ASPXAUTH')) throw new Error('No .ASPXAUTH cookie — login rejected.');

  // Land on the student page: sets the session's student and gives us the header token
  const home = await follow(res);
  const apiToken = extractToken(home.data);
  console.log(`  landed on ${new URL(home.config.url).pathname} (status ${home.status}), API token ${apiToken ? 'found' : 'NOT found'}`);
  if (!apiToken) throw new Error('No anti-forgery token on the student page.');
  return { apiToken, referer: home.config.url };
}

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

function expectJson(res, label) {
  const type = res.headers['content-type'] || '';
  if (res.status !== 200 || !type.includes('json')) {
    throw new Error(`${label}: status ${res.status}, content-type ${type || 'none'} (expected JSON)`);
  }
  return res.data;
}

const rowsOf = d => (Array.isArray(d) ? d : Array.isArray(d?.Data) ? d.Data : []);

async function fetchGrades(session) {
  console.log('Step 3: marking periods');
  let markingPeriods = null;
  try {
    markingPeriods = expectJson(await api(session, { method: 'get', path: '/ParentStudentDetails/GetMarkingPeriod' }), 'GetMarkingPeriod');
    console.log(`  ${JSON.stringify(markingPeriods).slice(0, 400)}`); // term names/IDs only
  } catch (e) {
    console.log(`  skipped: ${e.message}`);
  }

  console.log('Step 4: class grades');
  const progress = rowsOf(expectJson(await api(session, {
    path: `/ParentStudentDetails/ShowGridProgressInfo?markingPeriodId=${MARKING_PERIOD_ID}`,
    data: 'sort=&group=&filter=',
  }), 'ShowGridProgressInfo'));
  console.log(`  ${progress.length} classes, fields: ${Object.keys(progress[0] || {}).join(', ')}`);

  console.log('Step 5: coursework');
  const body = new URLSearchParams({
    sort: '', page: '1', pageSize: '20', group: '', filter: '',
    studentId: String(STUDENT_ID), sectionId: '0', courseworkRange: '1',
    courseworkType: 'All Types', token: '',
  });
  const coursework = rowsOf(expectJson(await api(session, {
    path: '/ParentStudentDetails/GetCourseworkDetailsByStudent',
    data: body.toString(),
  }), 'GetCourseworkDetailsByStudent'));
  console.log(`  ${coursework.length} assignments, fields: ${Object.keys(coursework[0] || {}).join(', ')}`);

  return { markingPeriods, progress, coursework };
}

async function runScraper() {
  try {
    const session = await login();
    const grades = await fetchGrades(session);

    console.log('Step 6: push to Firestore');
    const userId = process.env.PLUSPORTALS_USER.split('@')[0];
    await db.collection('users').doc(userId).collection('grades').doc('current').set({
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      markingPeriodId: MARKING_PERIOD_ID,
      ...grades,
    });
    console.log('Successfully updated dashboard data.');
  } catch (error) {
    console.error('Extraction Error:', error.message);
    process.exit(1);
  }
}
runScraper();
