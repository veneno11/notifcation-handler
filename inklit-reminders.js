// inklit-reminders.js: Duolingo-style reading and lesson reminders for InkLit.
//
// Runs hourly on GitHub Actions (cron '23 * * * *'). GitHub often starts scheduled runs
// 5 to 30 minutes late and now and then skips one, so every time in this file means
// "the first run at or after it", and anything missed catches up on the next run.
//
// At most two notifications per reader per day:
//   1. The daily reminder, if you haven't read yet. Like Duolingo, it's timed 23.5 hours
//      after you first read or learned the day before, so it lands when you're usually
//      free. Readers who pick a fixed hour in Settings get it then instead. If you've
//      already read but skipped your lesson, it becomes a lesson nudge (only if you do lessons).
//   2. A streak saver from about 9 PM, only if your reading streak ends at midnight.
// Miss days and the reminder becomes a short comeback series. After 6 missed days it sends
// one last message and goes quiet until you read or learn again.
//
// Which message: adapted from Duolingo's research (Yancey & Settles, KDD 2020). A message
// only goes to readers it fits, a recently used one is penalized (the penalty halves every
// 15 days) so they stay fresh, and messages that got you reading within 2 hours are
// slowly favored.
const admin = require('firebase-admin');

// ---------- Schedule (reader's local time) ----------
const QUIET_UNTIL = 7;          // never send before 7 AM
const QUIET_FROM = 23;          // or from 11 PM, so the last chance is the ~10:23 PM run
const LATEST_REMINDER = 21;     // the daily reminder is due by 9 PM at the latest
const SAVER_HOUR = 21;          // streak saver: first run from 9 PM, usually landing 9:25 to 9:50
const SAVER_GAP_MIN = 50;       // and at least 50 minutes after that day's reminder
const LEAD_MIN = 30;            // aim 30 minutes before yesterday's start (23.5 hours later)
const SMART_EARLY_MIN = 20;     // a run up to 20 minutes before that aim may send it
const HISTORY_DAYS = 7;         // how far back to look for a day with a known start time
const FINAL_AFTER = 6;          // missed days before the last message, then quiet
const LESSON_HABIT_DAYS = 14;   // lesson nudges only if you've done a lesson this recently
const ACTIVE_KEEP_DAYS = 21;    // older start times are cleaned out
const DEFAULT_HOUR = 19;
const DEFAULT_TZ = 'America/Guatemala';
const LESSON_WORDS = 7;
const MILESTONES = [3, 7, 14, 21, 30, 50, 75, 100, 150, 200, 365];
const TAG = 'inklit-reminder';  // one tag, so a newer reminder replaces an older one

// ---------- Message choice (Duolingo's recovering bandit, simplified) ----------
const HALF_LIFE_DAYS = 15;      // the "seen it lately" penalty halves every 15 days
const RECENCY_PENALTY = 1;      // full penalty for a message sent today
const PRIOR_SENDS = 4;          // a message needs a few sends before its track record counts
const TEMPERATURE = 0.25;       // higher = more variety
const CONVERT_MS = 2 * 3600e3;  // a message "worked" if you read or learned within 2 hours

// ---------- Setup ----------
const raw = process.env.INKLIT_SERVICE_ACCOUNT;
if (!raw) { console.log('No INKLIT_SERVICE_ACCOUNT secret, nothing to do.'); process.exit(0); }
const TEST = process.env.INKLIT_TEST === 'true';
const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) }, 'inklit');
const db = app.firestore();
const { FieldValue } = admin.firestore;

// ---------- Helpers ----------
const warn = text => console.log(`::warning::${text}`); // yellow note on the run page
const short = id => String(id).slice(0, 6);
const pad2 = n => String(n).padStart(2, '0');
const clockText = min => `${Math.floor(min / 60)}:${pad2(min % 60)}`;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function shorten(s, max = 24) {
  s = String(s || '').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
const firstWord = (s, max = 16) => shorten(String(s || '').trim().split(/\s+/)[0] || '', max);

function validTz(tz) {
  if (typeof tz !== 'string' || !tz) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}
const dayKeyIn = (tz, d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: tz });
function minuteIn(tz, d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const get = type => Number(parts.find(p => p.type === type)?.value || 0);
  return (get('hour') % 24) * 60 + get('minute');
}
const isDay = k => /^\d{4}-\d{2}-\d{2}$/.test(String(k || ''));
const shiftDay = (key, delta) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
};
const daysBetween = (a, b) => {
  const n = k => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((n(b) - n(a)) / 864e5);
};
function parseHour(v) { // 18, "18" or "18:00"
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').split(':')[0], 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}
function toMs(v) { // milliseconds, numeric text, ISO text or Firestore timestamps
  if (typeof v === 'number') return v;
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'string') return /^\d+$/.test(v) ? Number(v) : (Date.parse(v) || 0);
  return 0;
}

// ---------- Reading streak (same rule as the app) ----------
const didRead = (readDays, k) => { const v = readDays?.[k]; return v === true || Number(v) > 0; };
function runEndingAt(readDays, day) {
  let n = 0;
  while (didRead(readDays, day) && n < 4000) { n++; day = shiftDay(day, -1); }
  return n;
}
function streakOf(readDays, today) {
  const readToday = didRead(readDays, today);
  return { readToday, streak: runEndingAt(readDays, readToday ? today : shiftDay(today, -1)) };
}
function bestStreak(readDays) {
  let best = 0, run = 0, prev = null;
  Object.keys(readDays || {}).filter(k => isDay(k) && didRead(readDays, k)).sort().forEach(k => {
    run = prev && shiftDay(prev, 1) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  });
  return best;
}

// ---------- Activity: which days you read or learned, and when each day started ----------
function activityOf(meta, tz) {
  const readDays = (meta && meta.readDays) || {};
  const days = new Set(Object.keys(readDays).filter(k => isDay(k) && didRead(readDays, k)));
  const first = {};
  const stamps = [];
  const note = ms => {
    if (!ms) return;
    stamps.push(ms);
    const d = dayKeyIn(tz, new Date(ms));
    days.add(d);
    if (!first[d] || ms < first[d]) first[d] = ms;
  };
  // activeAt is written by the app when you first read and first learn each day
  Object.values((meta && meta.activeAt) || {}).forEach(v => [].concat(v).forEach(x => note(toMs(x))));
  const lessonAts = (Array.isArray(meta?.lessons) ? meta.lessons : []).map(l => toMs(l?.at)).filter(Boolean);
  lessonAts.forEach(note);
  const sorted = [...days].filter(isDay).sort();
  return { readDays, days, first, stamps, lessonAts, lastActive: sorted.pop() || null };
}

// When today's reminder is aimed: 23.5 hours after the last known start, or a fixed hour
const clampMin = m => Math.min(LATEST_REMINDER * 60, Math.max(QUIET_UNTIL * 60, Math.round(m)));
function reminderAim(act, setup, today) {
  if (setup.smart) {
    for (let i = 1; i <= HISTORY_DAYS; i++) {
      const ms = act.first[shiftDay(today, -i)];
      if (ms) return { min: clampMin(minuteIn(setup.tz, new Date(ms)) - LEAD_MIN), smart: true, early: SMART_EARLY_MIN };
    }
  }
  return { min: clampMin(setup.hour * 60), smart: false, early: 0 };
}

// ---------- Reminder state (users/{uid}/meta/reminders, only this job uses it) ----------
function normalizeState(s, today) {
  s = s && typeof s === 'object' ? s : {};
  return {
    createdDay: isDay(s.createdDay) ? s.createdDay : today,
    sent: s.sent && typeof s.sent === 'object' ? s.sent : {},       // last day each slot went out
    sentAt: s.sentAt && typeof s.sentAt === 'object' ? s.sentAt : {},
    pending: Array.isArray(s.pending) ? s.pending.filter(p => p && p.tpl && p.at) : [],
    tpl: s.tpl && typeof s.tpl === 'object' ? s.tpl : {},           // per message: n sent, c worked, last day used
    total: { n: Number(s.total?.n) || 0, c: Number(s.total?.c) || 0 },
    stoppedOn: isDay(s.stoppedOn) ? s.stoppedOn : null,
    updatedAt: Date.now()
  };
}

// Messages sent 2+ hours ago: did you read or learn within 2 hours of them?
function scorePending(state, act, now) {
  if (!state.pending.length) return false;
  const keep = [];
  for (const p of state.pending) {
    const at = Number(p.at) || 0;
    if (now < at + CONVERT_MS) { keep.push(p); continue; }
    const stamps = p.kind === 'lesson' ? act.lessonAts : act.stamps;
    const hit = stamps.some(ms => ms >= at && ms <= at + CONVERT_MS) ? 1 : 0;
    const st = state.tpl[p.tpl] || (state.tpl[p.tpl] = {});
    st.n = (Number(st.n) || 0) + 1;
    st.c = (Number(st.c) || 0) + hit;
    state.total.n++;
    state.total.c += hit;
  }
  state.pending = keep.slice(-10);
  return true;
}

async function pruneActiveAt(metaRef, meta, today) {
  const cutoff = shiftDay(today, -ACTIVE_KEEP_DAYS);
  const old = Object.keys(meta.activeAt || {}).filter(k => k < cutoff);
  if (!old.length) return;
  try { await metaRef.set({ activeAt: Object.fromEntries(old.map(k => [k, FieldValue.delete()])) }, { merge: true }); }
  catch (e) { warn(`Couldn't clean old start times (${e.message}).`); }
}

// ---------- Messages ----------
// Each message only goes to readers it fits (Duolingo's "sleeping arms").
// Emojis are fine here: these are push notifications.
const LEARN = { tab: 'learn', action: 'learn' };
const always = () => true;
const isMilestone = n => MILESTONES.includes(n);
const msg = (id, kind, when, title, body, opts = {}) =>
  ({ id, kind, when, title, body, tab: opts.tab || 'home', action: opts.action || '', boost: opts.boost || 0 });

const TEMPLATES = [
  // Daily reminder: you haven't read today
  msg('main.inky', 'main', always, c => `Hi${c.name ? ` ${c.name}` : ''}, it's Inky 🐙`, () => "Ready for today's reading? Even 5 minutes counts."),
  msg('main.fire', 'main', c => c.s >= 3, c => `🔥 ${c.s}-day streak`, c => `Keep it burning. A few pages today makes it ${c.s + 1}.`),
  msg('main.milestone', 'main', c => c.s >= 2 && isMilestone(c.s + 1), c => `🏆 One day from a ${c.s + 1}-day streak`, () => "Read today and it's yours.", { boost: 0.3 }),
  msg('main.page', 'main', c => c.s >= 1, () => 'Just one page?', c => `That's all it takes to keep your ${c.s}-day streak going.`),
  msg('main.habit', 'main', c => c.smart, () => "⏰ It's about when you usually read", c => (c.s ? `Grab your book. Your ${c.s}-day streak is waiting.` : 'Grab your book and start a streak today.')),
  msg('main.start', 'main', c => c.s === 0, () => '📚 Start a streak today', () => 'A few pages is all it takes. Day 1 is the easiest one.'),
  msg('main.bookLeft', 'main', c => c.book && c.book.left > 0 && c.book.left <= 40, c => `📖 ${plural(c.book.left, 'page')} left in ${c.book.title}`, () => "You're so close to the end. Finish it tonight?", { boost: 0.2 }),
  msg('main.bookSpot', 'main', c => c.book && c.book.page > 0, c => `📖 Back to ${c.book.title}?`, c => (c.book.pct != null ? `You're ${c.book.pct}% in. Inky saved your spot on page ${c.book.page}.` : `Inky saved your spot on page ${c.book.page}.`)),
  msg('main.combo', 'main', c => !c.lessonToday, () => '📚 Read, then learn', () => "A few pages and a 2-minute lesson. Inky's ready when you are."),
  msg('main.words', 'main', c => c.due >= 3, c => `🧠 ${c.due} words are ready for review`, () => 'Read a little first, then give them 2 minutes.'),
  msg('main.friendRead', 'main', c => c.friend && c.friend.readToday, c => `👀 ${c.friend.name} already read today`, () => 'Your turn. Keep up with your reading buddy.', { boost: 0.15 }),
  msg('main.friendAhead', 'main', c => c.friend && c.friend.streak > c.s, c => `🏁 ${c.friend.name} is on a ${c.friend.streak}-day streak`, c => (c.s ? `You're at ${c.s}. Read today to close the gap.` : 'Start yours today and catch up.'), { boost: 0.1 }),
  msg('main.cheer', 'main', c => c.cheer, c => `📣 ${c.cheer.name} cheered you on`, () => "Don't leave them hanging. Read a few pages today.", { boost: 0.3 }),

  // Lesson nudge: you read today but haven't done your lesson
  msg('lesson.due', 'lesson', c => c.due >= 1, c => `🧠 ${c.due === 1 ? '1 word needs' : `${c.due} words need`} you`, () => 'You read today, nice. Now a quick 2-minute review?', LEARN),
  msg('lesson.fresh', 'lesson', c => c.due === 0, () => `✨ ${LESSON_WORDS} fresh words are waiting`, () => "You already read today. Finish strong with today's lesson.", LEARN),
  msg('lesson.xp', 'lesson', always, () => '⚡ Easy XP', () => 'A 2-minute lesson is worth 20+ XP, and you already did the hard part.', LEARN),
  msg('lesson.safe', 'lesson', c => c.s >= 2, c => `✅ Your ${c.s}-day streak is safe`, () => "Make it a full day with today's 2-minute lesson.", LEARN),

  // Streak saver: late evening, streak ends at midnight
  msg('saver.midnight', 'saver', always, c => `🚨 Your ${c.s}-day streak ends at midnight`, () => 'Read one page before bed to save it.'),
  msg('saver.inky', 'saver', always, () => "Inky's getting nervous 😰", c => `Your ${c.s}-day streak is about to end. A couple of pages saves it.`),
  msg('saver.time', 'saver', always, () => '⏳ Still time', c => `Two minutes of reading keeps your ${c.s}-day streak alive.`),
  msg('saver.friend', 'saver', c => c.friend && c.friend.readToday, c => `${c.friend.name} kept their streak today`, () => "Don't let yours end. Read a page before midnight.", { boost: 0.15 }),
  msg('saver.book', 'saver', c => c.book, c => `📖 One more page of ${c.book.title}?`, c => `That's all it takes to save your ${c.s}-day streak.`),
  msg('saver.milestone', 'saver', c => isMilestone(c.s + 1), c => `😱 Your ${c.s + 1}-day milestone is one page away`, () => "The day ends at midnight. Don't let it slip."),

  // Comeback series: you've missed days (friends get a boost, like Duolingo found)
  msg('back.miss', 'comeback', always, () => 'Inky misses you 🐙', () => "Come back for 5 minutes. Your books aren't going anywhere."),
  msg('back.ended', 'comeback', c => c.lost >= 2 && c.daysSince <= 2, c => `Your ${c.lost}-day streak ended 💔`, () => 'Start a new one today. Day 1 is the easiest one.'),
  msg('back.spot', 'comeback', c => c.book && c.book.page > 0, c => `Still reading ${c.book.title}?`, c => `Inky saved your spot on page ${c.book.page}. Pick up where you left off.`),
  msg('back.words', 'comeback', c => c.due >= 3, c => `Your ${c.due} words miss you`, () => 'Without review they start to fade. Two minutes brings them back.', LEARN),
  msg('back.friend', 'comeback', c => c.friend && c.friend.readToday, c => `${c.friend.name} read today`, () => 'Want to get back on track together? A few pages is all it takes.', { boost: 0.3 }),
  msg('back.cheer', 'comeback', c => c.cheer, c => `📣 ${c.cheer.name} is cheering for you`, () => 'Come back and read a few pages today.', { boost: 0.3 }),
  msg('back.days', 'comeback', c => c.daysSince >= 3, c => `It's been ${c.daysSince} days`, () => 'Reading habits fade fast. Five minutes today brings yours back.'),
  msg('back.best', 'comeback', c => c.best >= 3, c => `Your best streak was ${c.best} days`, () => "You've done it before. Start again today."),
  msg('back.wait', 'comeback', c => c.daysSince >= 4, () => 'Inky is still waiting… 🐙', () => "Pages don't read themselves. Yet."),

  // Last message after 6 missed days, then quiet until you're back
  msg('final.pause', 'final', always, () => "Looks like these reminders aren't working 🥲", () => "Inky will stop sending them for now. Your books will be here when you're ready."),
  msg('final.door', 'final', always, () => 'Inky will stop bugging you', () => "No more reminders for now. Read one page whenever you're ready and they'll start again.")
];

const fits = (t, ctx) => { try { return !!t.when(ctx); } catch { return false; } };

// Softmax over (track record - recency penalty), from Duolingo's paper
function pickTemplate(kind, ctx, state, today) {
  const pool = TEMPLATES.filter(t => t.kind === kind && fits(t, ctx));
  if (!pool.length) return TEMPLATES.find(t => t.kind === kind && t.when === always);
  const base = (state.total.c + 1) / (state.total.n + 4); // your overall response rate, lightly smoothed
  const scored = pool.map(t => {
    const st = state.tpl[t.id] || {};
    const rate = ((Number(st.c) || 0) + PRIOR_SENDS * base) / ((Number(st.n) || 0) + PRIOR_SENDS);
    const lift = Math.max(-0.5, Math.min(0.5, (rate - base) / base));
    const penalty = isDay(st.last) ? RECENCY_PENALTY * Math.pow(0.5, daysBetween(st.last, today) / HALF_LIFE_DAYS) : 0;
    return { t, score: lift + t.boost - penalty };
  });
  const top = Math.max(...scored.map(x => x.score));
  const weights = scored.map(x => Math.exp((x.score - top) / TEMPERATURE));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < scored.length; i++) { r -= weights[i]; if (r <= 0) return scored[i].t; }
  return scored[scored.length - 1].t;
}

// Everything the messages can mention. Only loaded when something is about to be sent.
async function buildContext(userRef, act, info) {
  const { tz, today, now } = info;
  const safe = (fn, what) => Promise.resolve().then(fn).catch(e => { warn(`Couldn't load ${what} (${e.message}).`); return null; });
  const [profile, books, friends, cheers, due] = await Promise.all([
    safe(() => userRef.get(), 'profile'),
    safe(() => userRef.collection('books').where('status', '==', 'reading').get(), 'books'),
    safe(() => userRef.collection('friends').limit(20).get(), 'friends'),
    safe(() => userRef.collection('cheers').where('seen', '==', false).limit(20).get(), 'cheers'),
    safe(() => userRef.collection('vocab').where('nextDueDate', '<=', new Date(now).toISOString()).count().get(), 'review words')
  ]);

  // The friend worth mentioning: someone who read today, otherwise the longest streak
  let friend = null;
  const ids = friends ? friends.docs.map(d => d.id).slice(0, 10) : [];
  const fsnaps = ids.length ? await safe(() => db.getAll(...ids.map(id => db.collection('users').doc(id))), 'friends') : null;
  for (const s of fsnaps || []) {
    if (!s.exists) continue;
    const p = s.data();
    const fToday = dayKeyIn(validTz(p.tz) || tz);
    const readToday = p.lastRead === fToday;
    const alive = readToday || p.lastRead === shiftDay(fToday, -1);
    const f = { name: firstWord(p.name) || 'Your friend', streak: alive ? Number(p.streak) || 0 : 0, readToday };
    if (!friend || (f.readToday && !friend.readToday) || (f.readToday === friend.readToday && f.streak > friend.streak)) friend = f;
  }

  let cheer = null;
  const recent = (cheers ? cheers.docs.map(d => d.data()) : [])
    .filter(c => now - toMs(c.createdAt) < 3 * 864e5)
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
  if (recent.length) cheer = { name: firstWord(recent[0].fromName) || 'A friend', n: recent.length };

  let book = null;
  const reading = books ? books.docs.map(d => d.data()) : [];
  if (reading.length) {
    const b = reading.sort((x, y) => (toMs(y.lastReadAt) || toMs(y.createdAt)) - (toMs(x.lastReadAt) || toMs(x.createdAt)))[0];
    const total = parseInt(b.totalPages, 10) || 0, page = parseInt(b.currentPage, 10) || 0;
    book = { title: shorten(b.title || 'your book', 24), page, pct: total ? Math.round(page / total * 100) : null, left: total ? Math.max(0, total - page) : null };
  }

  const lastRead = Object.keys(act.readDays).filter(k => isDay(k) && didRead(act.readDays, k)).sort().pop() || null;
  return {
    name: profile && profile.exists ? firstWord(profile.get('name'), 14) : '',
    s: info.streak,
    best: bestStreak(act.readDays),
    lost: lastRead && lastRead < shiftDay(today, -1) ? runEndingAt(act.readDays, lastRead) : 0,
    daysSince: info.lastActive ? daysBetween(info.lastActive, today) : 0,
    smart: info.aim.smart,
    lessonToday: info.lessonToday,
    due: due ? Number(due.data().count) || 0 : 0,
    book, friend, cheer
  };
}

// ---------- One reader per pass ----------
async function processReader(userRef, docs, totals) {
  const label = `reader ${short(userRef.id)}`;
  const devs = docs.map(d => d.data());
  // The device that opened InkLit most recently sets the time zone and timing
  const primary = devs.reduce((a, b) => (toMs(b.updatedAt) > toMs(a.updatedAt) ? b : a));
  const tz = validTz(primary.tz) || validTz(primary.timeZone) || DEFAULT_TZ;
  const setup = { tz, hour: parseHour(primary.hour) ?? DEFAULT_HOUR, smart: primary.smart !== false };
  const now = Date.now();
  const today = dayKeyIn(tz);
  const nowMin = minuteIn(tz);

  if (!TEST && (nowMin < QUIET_UNTIL * 60 || nowMin >= QUIET_FROM * 60)) {
    console.log(`  ${label}: ${clockText(nowMin)} ${tz}, quiet hours`);
    return;
  }

  const metaRef = userRef.collection('meta').doc('progress');
  const stateRef = userRef.collection('meta').doc('reminders');
  const [metaSnap, stateSnap] = await Promise.all([metaRef.get(), stateRef.get()]);
  const meta = metaSnap.exists ? metaSnap.data() : {};
  const state = normalizeState(stateSnap.exists ? stateSnap.data() : null, today);
  let dirty = false;
  if (!stateSnap.exists) {
    // First run of this version: carry over what the old job already sent today
    const old = primary.lastSent || {};
    if (old.main === today) state.sent.main = today;
    if (old.lastCall === today) state.sent.saver = today;
    dirty = true;
  }

  const act = activityOf(meta, tz);
  if (scorePending(state, act, now)) dirty = true;
  if (!TEST) await pruneActiveAt(metaRef, meta, today);

  const { streak, readToday } = streakOf(act.readDays, today);
  const lessonToday = act.lessonAts.some(ms => dayKeyIn(tz, new Date(ms)) === today);
  const lessonHabit = act.lessonAts.some(ms => now - ms < LESSON_HABIT_DAYS * 864e5);
  const lastActive = act.lastActive;
  if (state.stoppedOn && lastActive && lastActive >= state.stoppedOn) { state.stoppedOn = null; dirty = true; } // back again
  const daysMissed = lastActive ? Math.max(0, daysBetween(lastActive, today) - 1) : Math.max(0, daysBetween(state.createdDay, today));
  const aim = reminderAim(act, setup, today);

  let kind = null, slot = 'main';
  if (TEST) {
    kind = readToday ? 'lesson' : daysMissed >= FINAL_AFTER ? 'final' : daysMissed >= 1 ? 'comeback' : 'main';
  } else if (!state.stoppedOn) {
    const reminderDue = state.sent.main !== today && nowMin >= aim.min - aim.early;
    const saverDue = !readToday && streak > 0 && state.sent.saver !== today && nowMin >= SAVER_HOUR * 60
      && (state.sent.main !== today || now - (Number(state.sentAt.main) || 0) >= SAVER_GAP_MIN * 60e3);
    if (reminderDue && !readToday) kind = daysMissed >= FINAL_AFTER ? 'final' : daysMissed >= 1 ? 'comeback' : 'main';
    else if (reminderDue && !lessonToday && lessonHabit) kind = 'lesson';
    else if (saverDue) { kind = 'saver'; slot = 'saver'; }
  }

  console.log(`  ${label}: ${clockText(nowMin)} ${tz}, streak ${streak}, read ${readToday ? 'yes' : 'no'}, lesson ${lessonToday ? 'yes' : 'no'}, `
    + `last active ${lastActive || 'never'}, reminder ${clockText(aim.min)} (${aim.smart ? 'smart' : 'fixed'})`
    + `${state.stoppedOn ? `, paused since ${state.stoppedOn}` : ''} -> ${kind || 'nothing due'}`);

  if (!kind) { if (dirty && !TEST) await stateRef.set(state); return; }

  const ctx = await buildContext(userRef, act, { tz, today, now, streak, lessonToday, lastActive, aim });
  const t = pickTemplate(kind, ctx, state, today);
  let title, body;
  try { title = t.title(ctx); body = t.body(ctx); }
  catch { title = "Hi, it's Inky 🐙"; body = "Ready for today's reading? Even 5 minutes counts."; }
  const data = { title, body, tab: t.tab, action: t.action, tag: TAG, kind, tpl: t.id };
  const ttl = String(kind === 'saver' ? 2 * 3600 : 3 * 3600);

  let delivered = 0;
  for (const doc of docs) {
    try {
      await app.messaging().send({ token: doc.get('token'), data, webpush: { headers: { Urgency: 'high', TTL: ttl } } });
      delivered++;
      totals.sent++;
    } catch (e) {
      const code = e?.code || '';
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        await doc.ref.delete();
        totals.removed++;
        warn(`device ${short(doc.id)} (${label}) was dropped by the browser and removed. Turn reminders on again in InkLit on that device.`);
      } else {
        totals.failed++;
        warn(`device ${short(doc.id)} (${label}): send failed (${code || e.message}). The next run will try again.`);
      }
    }
  }
  console.log(`    ${delivered ? 'sent' : 'could not send'} ${t.id} to ${delivered} of ${docs.length} device(s)`);

  if (delivered && !TEST) {
    state.sent[slot] = today;
    state.sentAt[slot] = now;
    state.pending.push({ tpl: t.id, kind, at: now });
    state.tpl[t.id] = { ...(state.tpl[t.id] || {}), last: today };
    if (kind === 'final') state.stoppedOn = today;
    dirty = true;
  }
  if (dirty && !TEST) await stateRef.set(state);
}

// ---------- Main ----------
async function main() {
  const snap = await db.collectionGroup('devices').get();
  let docs = snap.docs.filter(doc => {
    const userRef = doc.ref.parent.parent;
    const d = doc.data();
    return userRef && userRef.parent.id === 'users' && typeof d.token === 'string' && d.enabled !== false;
  });
  if (TEST && docs.length) {
    // A test only goes to the device that opened InkLit most recently: open InkLit, then run it
    docs = [docs.reduce((a, b) => (toMs(b.get('updatedAt')) > toMs(a.get('updatedAt')) ? b : a))];
  }
  const byUser = new Map();
  docs.forEach(doc => {
    const uid = doc.ref.parent.parent.id;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(doc);
  });
  console.log(`${docs.length} device(s) across ${byUser.size} reader(s)${TEST ? ', test run: sends a preview now and saves nothing' : ''}`);
  if (!byUser.size) warn('No devices have reminders on. Turn reminders on in InkLit on your phone.');

  const totals = { sent: 0, removed: 0, failed: 0 };
  for (const list of byUser.values()) {
    const userRef = list[0].ref.parent.parent;
    try { await processReader(userRef, list, totals); }
    catch (e) { totals.failed++; warn(`reader ${short(userRef.id)}: ${e.message}`); }
  }
  console.log(`Sent ${totals.sent}, removed ${totals.removed} expired device(s), ${totals.failed} failed.`);
  return totals.failed;
}

main()
  .then(failed => process.exit(failed ? 1 : 0)) // a failure turns the run red, so GitHub emails you
  .catch(e => { console.error('Reminder job failed:', e.message); process.exit(1); });
