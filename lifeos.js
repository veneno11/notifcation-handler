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
  const s = String(v ?? '');
  const ms = s.match(/\/Date\((-?\d+)/);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
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
