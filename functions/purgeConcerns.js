import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

async function purgeAllConcerns() {
  const db = admin.firestore();
  console.log("purging concerns...");
  const snapshot = await db.collection('concerns').get();
  if (snapshot.empty) {
    console.log("No concerns found to delete.");
    return;
  }
  
  const batch = db.batch();
  snapshot.docs.forEach(doc => {
    batch.delete(doc.ref);
  });
  
  await batch.commit();
  console.log(`Deleted ${snapshot.size} concern documents.`);
}

purgeAllConcerns()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
