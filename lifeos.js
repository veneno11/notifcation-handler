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

// Same assignment = same key, even if the teacher changes the due date
const itemKey = it => crypto.createHash('sha1')
  .update([it.AssignmentID, it.LessonActivityID, it.DiscussionTopicID, it.SectionID, cleanText(it.Title)].map(v => String(v ?? '')).join('|'))
  .digest('hex').slice(0, 16);

// PlusPortals dates are calendar days -> "YYYY-MM-DD", the format LifeOS uses
function toISODate(v) {
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

  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);      // 11/05/2026 (month first, like PlusPortals)
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

async function syncLifeOS(items) {
  const raw = process.env.LIFEOS_SERVICE_ACCOUNT;
  if (!raw) { console.log('  skipped: no LIFEOS_SERVICE_ACCOUNT secret'); return; }

  const app = admin.apps.find(a => a && a.name === 'lifeos')
    || admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) }, 'lifeos');
  const db = app.firestore();
  const base = db.collection('artifacts').doc(APP_ID).collection('users').doc(ACCOUNT).collection('appData');
  const stateRef = base.doc('state');
  const ledgerRef = base.doc('plusportalsSync'); // what's been imported, so deleted tasks stay deleted
  const devicesRef = base.doc('pushDevices');

  const added = [];
  let completed = 0, moved = 0, baseline = false;

  await db.runTransaction(async tx => {
    added.length = 0; completed = 0; moved = 0; // transactions can retry
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
      const idx = indexById.get(id);
      const entry = ledger[key];

      if (!entry) {
        ledger[key] = { at: now, due };
        if (doneInPP || idx !== undefined) continue;
        const task = {
          id,
          title: cleanText(it.Title) || 'Untitled',
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
      if (doneInPP && !task.completed) { tasks[idx] = { ...tasks[idx], completed: true }; completed++; }
      // Teacher moved the due date and you hadn't changed it yourself
      if (!task.completed && entry.due !== due && task.dueDate === entry.due) { tasks[idx] = { ...tasks[idx], dueDate: due }; moved++; }
      ledger[key] = { ...entry, due };
    }

    const cutoff = now - 180 * 864e5;
    for (const [k, v] of Object.entries(ledger)) if (!v || v.at < cutoff) delete ledger[k];

    if (added.length || completed || moved) tx.update(stateRef, { tasks });
    tx.set(ledgerRef, { imported: ledger, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });

  console.log(`  ${added.length} added${baseline ? ' (first sync, no alerts)' : ''}, ${completed} marked done, ${moved} due dates moved`);
  if (!baseline && added.length) await notify(app, devicesRef, added);
}

module.exports = { syncLifeOS };
