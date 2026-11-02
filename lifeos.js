// lifeos.js: adds new PlusPortals coursework to Leo's LifeOS and alerts LifeOS devices.
const crypto = require('crypto');
const admin = require('firebase-admin');

const APP_ID = 'leo-lifeos-local';
const ACCOUNT = 'leo-main-sync-account';

// PlusPortals class name -> LifeOS course (capitals and accents are ignored)
const COURSES = [
  [/a\.\s*litera|english|ingles|american/, 'American Lit'],
  [/^literatura|spanish|espanol/, 'Spanish Lit'],
  [/alem|german/, 'German'],
  [/chem|quimic/, 'AP Chemistry'],
  [/econom/, 'AP Economics'],
  [/precalc|calc|math|matemat/, 'AP Precalculus'],
  [/compsci|comp.*sci|computer|computac/, 'Computer Science'],
  [/elabpro|elaboracion|proyecto/, 'Elaboración de Proyectos'],
  [/filosof|philosoph/, 'Filosofía'],
];

// Other ways teachers write each class in titles (lowercase, no accents)
const COURSE_ALIASES = {
  'American Lit': ['american literature', 'american lit', 'a. literature', 'a. lit', 'english literature', 'english'],
  'Spanish Lit': ['lengua y literatura', 'spanish literature', 'spanish lit', 'literatura', 'espanol'],
  'German': ['aleman', 'german', 'deutsch'],
  'AP Chemistry': ['ap chemistry', 'ap chem', 'ap quimica', 'chemistry', 'quimica', 'chem'],
  'AP Economics': ['ap macroeconomics', 'ap microeconomics', 'ap economics', 'ap econ', 'economics', 'economia', 'econ'],
  'AP Precalculus': ['ap pre-calculus', 'ap precalculus', 'ap precalc', 'pre-calculus', 'precalculus', 'pre calc', 'precalc'],
  'Computer Science': ['ciencias de la computacion', 'ciencia de la computacion', 'computer science', 'computacion', 'comp sci', 'compsci', 'cs'],
  'Elaboración de Proyectos': ['elaboracion de proyectos', 'elaboracion de proyecto', 'elaboracion', 'elab pro', 'elabpro'],
  'Filosofía': ['filosofia', 'philosophy'],
};

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const isTrue = v => String(v).toLowerCase() === 'true';
const cleanText = s => String(s ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

function lifeOsCourse(name) {
  const hit = COURSES.find(([re]) => re.test(norm(name)));
  return hit ? hit[1] : cleanText(name).replace(/\s*\(.*$/, ''); // e.g. "BKB MascHS (F24)…" -> "BKB MascHS"
}

function lifeOsType(type, title) {
  const t = norm(`${type} ${title}`);
  if (/quiz|comprobacion/.test(t)) return 'Quiz';
  if (/test|exam|prueba|evaluacion/.test(t)) return 'Exam';
  if (/project|proyecto/.test(t)) return 'Project';
  if (/classwork|clase|lesson|activit|actividad|discuss|foro/.test(t)) return 'Classwork';
  return 'Homework';
}

// Same assignment = same key, even if the teacher changes the due date (don't change this)
const itemKey = it => crypto.createHash('sha1')
  .update([it.AssignmentID, it.LessonActivityID, it.DiscussionTopicID, it.SectionID, cleanText(it.Title)].map(v => String(v ?? '')).join('|'))
  .digest('hex').slice(0, 16);

// ---------- Due dates ----------

const MONTHS = { jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dec: 12, dic: 12 };
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${pad(m)}-${pad(d)}` : null;

// Any PlusPortals due date -> "YYYY-MM-DD" (the calendar day, no timezone shifts)
function toISODate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'object' && typeof v.toDate === 'function') return toISODate(v.toDate());
  const s = String(v).trim();

  let m = s.match(/\/Date\((-?\d+)/);                          // /Date(1793505171827)/
  if (m) return toISODate(new Date(Number(m[1])));
  if (/^\d{10,13}$/.test(s)) return toISODate(new Date(Number(s.length === 10 ? s * 1000 : s)));

  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);                  // 2026-11-05
  if (m) return ymd(+m[1], +m[2], +m[3]);

  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);      // 11-10-2026 (month first, like PlusPortals)
  if (m) {
    const a = +m[1], b = +m[2];
    return a > 12 && b <= 12 ? ymd(+m[3], b, a) : ymd(+m[3], a, b); // 25/11/2026 can only be day first
  }

  // Text months: "Nov 5, 2026", "Thursday, November 05, 2026", "5 de noviembre de 2026"
  const noTime = s.replace(/\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?/i, ' ');
  const year = noTime.match(/\b(\d{4})\b/);
  const month = norm(noTime).match(/\b(ene|jan|feb|mar(?!tes)|abr|apr|may|jun|jul|ago|aug|sep|set|oct|nov|dic|dec)[a-z]*/);
  if (year && month) {
    const day = noTime.replace(year[1], ' ').match(/\b(\d{1,2})\b/);
    if (day) return ymd(+year[1], MONTHS[month[1]], +day[1]);
  }
  return null;
}

const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guatemala' });
const dueText = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---------- Titles ----------

const GRADE_LEVEL = '11'; // your grade: change to '12' next school year
const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'of', 'the', 'and', 'ap']);

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Lowercase, accent-free copy with exactly the same length, so match positions line up with the original
const keyed = s => String(s).split('').map(ch => (norm(ch) || ' ')[0]).join('');
// "proyectos" -> matches "proy", "proye", … "proyectos" (at least `min` letters)
const prefixRe = (w, min) => w.length <= min ? escRe(w)
  : escRe(w.slice(0, min)) + w.slice(min).split('').reduceRight((acc, ch) => `(?:${escRe(ch)}${acc})?`, '');

const GRADE = `(?:grade\\s*)?${GRADE_LEVEL}\\s*(?:st|nd|rd|th|vo|mo|°|º)(?:\\s*grade)?|grade\\s*${GRADE_LEVEL}|${GRADE_LEVEL}\\s*grade`;
const SEP = '[\\s\\-–—:|·.,;/]';

// Teacher shorthand built from a class name: "Elab Proy", "Comp Sci", "Chem", "Precalc", "Filo"…
function abbreviationRe(name) {
  const words = norm(name).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w && !STOPWORDS.has(w));
  if (!words.length || words[0].length < 4) return null;
  const rest = words.slice(1).filter(w => w.length >= 3)
    .map(w => `(?:[\\s.]+(?:(?:de|del|la|y)[\\s.]+)?${prefixRe(w, 3)})?`).join('');
  return prefixRe(words[0], 4) + rest;
}

// Removes the class name, its shorthand, "11th" and your section ("11.01") from PlusPortals titles
function cleanTitle(it) {
  const raw = cleanText(it.Title) || 'Untitled';
  const course = lifeOsCourse(it.CourseName || it.Class);
  const ppNames = [it.CourseName, it.Class].map(cleanText).filter(Boolean);
  const names = [...new Set(
    [...ppNames.flatMap(n => [n, n.replace(/\s*\(.*$/, '')]), course, ...(COURSE_ALIASES[course] || [])]
      .map(a => norm(a).trim()).filter(a => a.length >= 2)
  )];

  // The class name exactly, plus shorthand built from it
  const variants = [
    ...names.slice().sort((a, b) => b.length - a.length).map(escRe),
    ...new Set(names.map(abbreviationRe).filter(Boolean)),
  ];
  // Your section from PlusPortals' class code: "… 0832/01" -> 11.01, 11-01, 11.1, 11/01
  const sectionNo = (ppNames.join(' ').match(/\d{3,4}\s*\/\s*(\d{1,2})/) || [])[1];
  const SECTION = sectionNo ? `${GRADE_LEVEL}\\s*[.\\-/]\\s*0*${Number(sectionNo)}(?![0-9])` : '(?!)';
  const EXACT_SECTION = sectionNo ? `${GRADE_LEVEL}\\s*[.\\-/]\\s*${sectionNo.padStart(2, '0')}(?![0-9])` : '(?!)';

  const CLASS = variants.length
    ? `(?:ap\\s+)?(?:${variants.join('|')})(?:\\s*${GRADE_LEVEL}(?![0-9.\\-/]))?(?![a-z0-9])`
    : '(?!)';
  const GRADE_TAG = `(?:${GRADE})(?![a-z0-9])`;
  const TAG = `(?:${CLASS}|${SECTION}|${GRADE_TAG})`;
  const LABEL = '[^\\d:|()\\[\\]\\-–—]{1,30}?'; // any short label right before your section code

  const leadLabel = new RegExp(`^\\s*[(\\[]?${LABEL}\\s*${SECTION}\\s*[)\\]]?`);             // "LLAB Proy 11.01 - …"
  const lead = new RegExp(`^(?:${SEP}|[(\\[]\\s*${TAG}(?:\\s*${TAG})*\\s*[)\\]]|${TAG})+`);  // "CompSci 11th: …"
  const trail = new RegExp(`(?:\\s*[\\-–—:|,]\\s*${TAG}(?:\\s*${TAG})*|\\s*[(\\[]\\s*${TAG}(?:\\s*${TAG})*\\s*[)\\]])\\s*$`); // "… - Chem"
  const trailLabel = new RegExp(`\\s*[\\-–—:|,(\\[]\\s*${LABEL}\\s*${SECTION}\\s*[)\\]]?\\s*$`); // "… (Elab Proy 11.01)"
  const stray = new RegExp(`(?:^|\\s)[(\\[]?(?:${GRADE_TAG}|${EXACT_SECTION})[)\\]]?`);       // "11th" / "11.01" anywhere

  let t = raw;
  const cut = re => {
    const m = keyed(t).match(re);
    if (!m || !m[0]) return false;
    t = `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`;
    return true;
  };
  cut(leadLabel);
  cut(lead);
  for (let i = 0; i < 4 && (cut(trail) || cut(trailLabel)); i++);
  for (let i = 0; i < 3 && cut(stray); i++);
  t = t.replace(/\s+/g, ' ').replace(/^[\s\-–—:|·.,;/]+/, '').replace(/[\s\-–—:|,;/]+$/, '').trim();
  return t || raw;
}

// ---------- Notifications ----------

function buildMessage(added) {
  if (added.length === 1) {
    const t = added[0];
    return { title: `📚 New assignment${t.course ? ` · ${t.course}` : ''}`, body: `${t.title} — due ${dueText(t.dueDate)}` };
  }
  const lines = added.slice(0, 4).map(t => `${t.course ? `${t.course}: ` : ''}${t.title}`);
  if (added.length > 4) lines.push(`+${added.length - 4} more`);
  return { title: `📚 ${added.length} new assignments`, body: lines.join('\n') };
}

async function notify(app, devicesRef, added) {
  const snap = await devicesRef.get();
  const tokens = (snap.exists && snap.get('tokens')) || {};
  const entries = Object.entries(tokens).filter(([, v]) => v && typeof v.token === 'string');
  if (!entries.length) { console.log('  no LifeOS devices have alerts on'); return; }

  const msg = buildMessage(added);
  const res = await app.messaging().sendEachForMulticast({
    tokens: entries.map(([, v]) => v.token),
    data: { title: msg.title, body: msg.body, tag: `pp-${Date.now()}` },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } },
  });

  const expired = {};
  res.responses.forEach((r, i) => {
    const code = r.error?.code || '';
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      expired[`tokens.${entries[i][0]}`] = admin.firestore.FieldValue.delete();
    } else if (!r.success) {
      console.log(`  device ${i + 1}: ${code || r.error?.message}`);
    }
  });
  if (Object.keys(expired).length) await devicesRef.update(expired);
  console.log(`  alerted ${res.successCount} of ${entries.length} device(s)`);
}

// ---------- Main ----------

async function syncLifeOS(items) {
  const raw = process.env.LIFEOS_SERVICE_ACCOUNT;
  if (!raw) { console.log('  skipped: no LIFEOS_SERVICE_ACCOUNT secret'); return; }
  if (items[0]) console.log(`  sample due date from PlusPortals: ${JSON.stringify(items[0].DueDate)}`);

  const app = admin.apps.find(a => a && a.name === 'lifeos')
    || admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) }, 'lifeos');
  const db = app.firestore();
  const base = db.collection('artifacts').doc(APP_ID).collection('users').doc(ACCOUNT).collection('appData');
  const stateRef = base.doc('state');
  const ledgerRef = base.doc('plusportalsSync'); // what's been imported, so deleted tasks stay deleted
  const devicesRef = base.doc('pushDevices');

  const added = [];
  let completed = 0, moved = 0, renamed = 0, baseline = false;

  await db.runTransaction(async tx => {
    added.length = 0; completed = 0; moved = 0; renamed = 0; // transactions can retry
    const [stateSnap, ledgerSnap] = await tx.getAll(stateRef, ledgerRef);
    if (!stateSnap.exists) throw new Error('LifeOS data not found. Open LifeOS once so it syncs.');
    baseline = !ledgerSnap.exists;

    const tasks = Array.isArray(stateSnap.get('tasks')) ? [...stateSnap.get('tasks')] : [];
    const ledger = { ...((ledgerSnap.exists && ledgerSnap.get('imported')) || {}) };
    const indexById = new Map(tasks.map((t, i) => [t && t.id, i]));
    const now = Date.now();

    for (const it of items) {
      const key = itemKey(it);
      const id = `pp_${key}`;
      const due = toISODate(it.DueDate) || todayISO();
      const doneInPP = isTrue(it.IsCompleted);
      const title = cleanTitle(it);
      const idx = indexById.get(id);
      const entry = ledger[key];

      if (!entry) {
        ledger[key] = { at: now, due, title };
        if (doneInPP || idx !== undefined) continue;
        const task = {
          id,
          title,
          course: lifeOsCourse(it.CourseName || it.Class),
          type: lifeOsType(it.Type, it.Title),
          dueDate: due,
          completed: false,
          source: 'plusportals',
        };
        tasks.push(task);
        indexById.set(id, tasks.length - 1);
        added.push(task);
        continue;
      }

      if (idx === undefined) continue; // you deleted it in LifeOS: leave it gone
      const task = tasks[idx];

      // Re-clean titles from earlier imports, unless you renamed the task yourself
      const rawTitle = cleanText(it.Title) || 'Untitled';
      const untouched = task.title === rawTitle || task.title === entry.title
        || (!entry.title && keyed(task.title).includes(keyed(title)));
      if (task.title !== title && untouched) { tasks[idx] = { ...tasks[idx], title }; renamed++; }

      if (doneInPP && !task.completed) { tasks[idx] = { ...tasks[idx], completed: true }; completed++; }
      // Teacher moved the due date and you hadn't changed it yourself
      if (!task.completed && entry.due !== due && task.dueDate === entry.due) { tasks[idx] = { ...tasks[idx], dueDate: due }; moved++; }
      ledger[key] = { ...entry, due, title: tasks[idx].title === title ? title : (entry.title || null) };
    }

    const cutoff = now - 180 * 864e5;
    for (const [k, v] of Object.entries(ledger)) if (!v || v.at < cutoff) delete ledger[k];

    if (added.length || completed || moved || renamed) tx.update(stateRef, { tasks });
    tx.set(ledgerRef, { imported: ledger, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });

  console.log(`  ${added.length} added${baseline ? ' (first sync, no alerts)' : ''}, ${completed} marked done, ${moved} due dates moved, ${renamed} titles tidied`);
  if (!baseline && added.length) await notify(app, devicesRef, added);
}

module.exports = { syncLifeOS };
