// inklit-reminders.js: hourly job that sends InkLit reading and daily-lesson reminders.
// Runs on GitHub Actions with a service account for the InkLit Firebase project.
const admin = require('firebase-admin');

const LAST_CALL_HOUR = 21; // 9 PM "last call"
const QUIET_FROM = 23;     // never send at 11 PM or later
const LESSON_WORDS = 7;    // words per InkLit lesson
const TAG = 'inklit-reminder';

const raw = process.env.INKLIT_SERVICE_ACCOUNT;
if (!raw) { console.log('No INKLIT_SERVICE_ACCOUNT secret, nothing to do.'); process.exit(0); }
const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) }, 'inklit');
const db = app.firestore();

const dayKeyIn = (tz, d = new Date()) => {
  try { return d.toLocaleDateString('en-CA', { timeZone: tz }); } catch { return d.toISOString().slice(0, 10); }
};
const hourIn = (tz, d = new Date()) => {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(d)) % 24; }
  catch { return d.getUTCHours(); }
};
const shiftDay = (key, delta) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
};

// Same streak rule as the app: today counts if you've read, otherwise the run ending yesterday
function streakOf(readDays, today) {
  const did = k => Number(readDays?.[k]) > 0;
  const readToday = did(today);
  let day = readToday ? today : shiftDay(today, -1);
  let streak = 0;
  while (did(day) && streak < 4000) { streak++; day = shiftDay(day, -1); }
  return { streak, readToday };
}

async function loadStatus(userRef) {
  const [meta, due] = await Promise.all([
    userRef.collection('meta').doc('progress').get(),
    userRef.collection('vocab').where('nextDueDate', '<=', new Date().toISOString()).count().get(),
  ]);
  const lessons = meta.exists ? meta.get('lessons') : null;
  return {
    readDays: (meta.exists && meta.get('readDays')) || {},
    lessonAts: (Array.isArray(lessons) ? lessons : []).map(l => Number(l?.at) || 0).filter(Boolean),
    due: due.data().count || 0,
  };
}

// Emojis are fine here: these are push notifications
function messageFor(kind, s, tz, today) {
  const { streak, readToday } = streakOf(s.readDays, today);
  const lessonToday = s.lessonAts.some(at => dayKeyIn(tz, new Date(at)) === today);
  const wordsDue = s.due === 1 ? '1 word is' : `${s.due} words are`;
  const read = { tab: 'home', action: '' };
  const learn = { tab: 'learn', action: 'learn' };

  if (kind === 'lastCall') {
    if (!readToday && streak) {
      return {
        title: `🔥 Last call for your ${streak}-day streak`,
        body: lessonToday ? 'Read a few pages before bed to keep it alive.' : 'Read a few pages before bed. Your lesson is still waiting too.',
        ...read,
      };
    }
    if (readToday && !lessonToday) return { title: "🧠 Still time for today's lesson", body: 'A quick 2 minutes with Inky before bed.', ...learn };
    return null;
  }

  if (!readToday && !lessonToday) {
    return streak
      ? { title: `🔥 Keep your ${streak}-day streak going`, body: `Read a few pages, then do today's 2-minute lesson.${s.due ? ` ${wordsDue} ready for review.` : ''}`, ...read }
      : { title: '📚 Time to read and learn', body: `A few pages starts a new streak, and ${s.due ? `${wordsDue} ready for review` : `${LESSON_WORDS} fresh words are waiting`}.`, ...read };
  }
  if (!readToday) {
    return streak
      ? { title: `🔥 Keep your ${streak}-day streak going`, body: "Nice work on today's lesson. Read a few pages to keep your streak.", ...read }
      : { title: '📚 Time to read', body: "You did today's lesson. A few pages starts a new streak.", ...read };
  }
  if (!lessonToday) {
    return {
      title: "🧠 Time for today's lesson",
      body: s.due ? `${wordsDue} ready for review. It takes about 2 minutes.` : `${LESSON_WORDS} fresh words with Inky, about 2 minutes.`,
      ...learn,
    };
  }
  return null; // read and did a lesson today: no nudge needed
}

async function main() {
  const snap = await db.collectionGroup('devices').get();
  const byUser = new Map();
  snap.forEach(doc => {
    const userRef = doc.ref.parent.parent;
    const d = doc.data();
    if (!userRef || userRef.parent.id !== 'users' || typeof d.token !== 'string' || d.enabled === false) return;
    if (!byUser.has(userRef.id)) byUser.set(userRef.id, []);
    byUser.get(userRef.id).push(doc);
  });
  console.log(`${snap.size} device(s) across ${byUser.size} reader(s)`);

  let sent = 0, skipped = 0, removed = 0;
  for (const docs of byUser.values()) {
    const userRef = docs[0].ref.parent.parent;
    let status = null; // loaded once per reader, only if one of their devices is due
    for (const doc of docs) {
      const d = doc.data();
      const tz = d.tz || 'UTC';
      const today = dayKeyIn(tz);
      const hour = hourIn(tz);
      const remindAt = Number.isInteger(d.hour) ? d.hour : 19;
      const last = d.lastSent || {};

      // "At or after" the chosen hour, so a late GitHub run still sends it
      let kind = null;
      if (hour >= remindAt && hour < QUIET_FROM && last.main !== today) kind = 'main';
      else if (hour >= LAST_CALL_HOUR && hour < QUIET_FROM && remindAt < LAST_CALL_HOUR && last.main === today && last.lastCall !== today) kind = 'lastCall';
      if (!kind) continue;

      status = status || await loadStatus(userRef);
      const msg = messageFor(kind, status, tz, today);
      if (msg) {
        try {
          await app.messaging().send({
            token: d.token,
            data: { ...msg, tag: TAG },
            webpush: { headers: { Urgency: 'high', TTL: String(3 * 3600) } },
          });
          sent++;
        } catch (e) {
          const code = e?.code || '';
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            await doc.ref.delete();
            removed++;
          } else {
            console.log(`  send failed: ${code || e.message}`);
          }
          continue; // not marked as sent, so the next hourly run tries again
        }
      } else {
        skipped++;
      }
      await doc.ref.update({ [`lastSent.${kind}`]: today });
    }
  }
  console.log(`Sent ${sent}, nothing needed for ${skipped}, removed ${removed} expired device(s).`);
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error('Reminder job failed:', e.message); process.exit(1); });
