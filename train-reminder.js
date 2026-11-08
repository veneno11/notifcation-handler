// Evening "Did you train today?" push for Leo's LifeOS.
// Skips the reminder if today is already logged (a split or a rest day).
const admin = require('firebase-admin');

const LIFEOS_URL = 'https://PASTE-YOUR-LIFEOS-ADDRESS/'; // where you open LifeOS, ending in /
const TZ = 'America/Chicago';
const BASE = 'artifacts/leo-lifeos-local/users/leo-main-sync-account/appData';
const SPLITS = { chest: 'Chest & shoulders', back: 'Back & biceps', arms: 'Arms', legs: 'Legs & core' };

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.LIFEOS_SERVICE_ACCOUNT)) });
const db = admin.firestore();

async function main() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const state = (await db.doc(`${BASE}/state`).get()).data() || {};
  const hist = state.splitHistory || {};
  const dates = key => [].concat(hist[key] || []); // newest first
  if (Object.keys(hist).some(k => dates(k).includes(today))) {
    console.log('Today is already logged. No reminder.');
    return;
  }

  const devicesRef = db.doc(`${BASE}/pushDevices`);
  const devices = Object.entries((await devicesRef.get()).data()?.tokens || {}).filter(([, d]) => typeof d?.token === 'string');
  if (!devices.length) { console.log('No devices have alerts on.'); return; }

  // The split you've gone longest without (never trained comes first)
  const next = Object.keys(SPLITS).sort((a, b) => (dates(a)[0] || '').localeCompare(dates(b)[0] || ''))[0];

  const res = await admin.messaging().sendEachForMulticast({
    tokens: devices.map(([, d]) => d.token),
    notification: { title: 'Did you train today?', body: `Tap to log it. ${SPLITS[next]} is up next.` },
    webpush: { fcmOptions: { link: `${LIFEOS_URL}?checkin=1` } },
  });

  // Forget devices that turned alerts off or uninstalled
  const dead = {};
  res.responses.forEach((r, i) => {
    const code = r.error?.code || '';
    if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
      dead[devices[i][0]] = admin.firestore.FieldValue.delete();
    }
  });
  if (Object.keys(dead).length) await devicesRef.set({ tokens: dead }, { merge: true });
  console.log(`Sent to ${res.successCount} of ${devices.length} device(s).`);
}

main().then(() => process.exit(0)).catch(e => { console.error('Reminder failed:', e.message); process.exit(1); });
