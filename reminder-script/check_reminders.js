/**
 * ═══════════════════════════════════════════════════════════════
 *  VEDHA PANCHANGAM — FREE REMINDER SENDER (via GitHub Actions)
 * ═══════════════════════════════════════════════════════════════
 *  Runs on a schedule via GitHub Actions (see
 *  .github/workflows/send-reminders.yml) — checks Firestore's
 *  `pending_reminders` collection for anything due, and sends a push
 *  notification DIRECTLY via Firebase Cloud Messaging's HTTP v1 API.
 *
 *  Why this needs NO Firebase Blaze plan and NO OneSignal limits:
 *    - FCM sending is 100% free and unlimited on Firebase's Spark
 *      (free) plan — the ONLY thing that needed Blaze was running
 *      the periodic "check" logic via Cloud Functions. GitHub
 *      Actions' free scheduled workflows replace that role, for $0.
 *    - There's no per-user or MAU cap here (unlike OneSignal's free
 *      tier) — this scales to any number of app users.
 *
 *  Firestore structure it reads (written by the Flutter app):
 *    Collection: pending_reminders
 *    Document (auto-ID):
 *      fcm_token: "..."
 *      title: "Vedha Panchangam — Reminder"
 *      body: "Temple visit (09:00)"
 *      scheduled_time: Timestamp (UTC)
 *      sent: false
 * ═══════════════════════════════════════════════════════════════
 */

const admin = require('firebase-admin');

// The service account JSON is provided via a GitHub Secret (see
// workflow file) and written to this env var as a JSON string.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function main() {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  const snapshot = await db
    .collection('pending_reminders')
    .where('sent', '==', false)
    .where('scheduled_time', '<=', now)
    .get();

  if (snapshot.empty) {
    console.log('No due reminders.');
    return;
  }

  console.log(`Found ${snapshot.size} due reminder(s).`);

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (!data.fcm_token) {
      console.warn(`Reminder ${doc.id} has no fcm_token — skipping.`);
      await doc.ref.update({ sent: true, error: 'no_fcm_token' });
      continue;
    }

    const message = {
      token: data.fcm_token,
      notification: {
        title: data.title || 'Vedha Panchangam — Reminder',
        body: data.body || '',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'vedha_panchangam_channel',
        },
      },
    };

    try {
      await admin.messaging().send(message);
      await doc.ref.update({
        sent: true,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`Sent reminder ${doc.id}`);
    } catch (err) {
      console.error(`Failed to send reminder ${doc.id}:`, err.message);
      await doc.ref.update({ sent: true, error: err.message });
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
