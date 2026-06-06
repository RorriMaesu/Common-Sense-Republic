import * as admin from 'firebase-admin';

export async function runWeeklyPinning() {
  const db = admin.firestore();
  
  // Get all open ballots
  const ballotsSnap = await db.collection('ballots')
    .where('status', '==', 'open')
    .get();
    
  if (ballotsSnap.empty) {
    console.log('No open ballots to pin.');
    return;
  }
  
  const ballots: any[] = [];
  for (const doc of ballotsSnap.docs) {
    const data = doc.data();
    
    // Count votes
    const votesSnap = await db.collection('votes')
      .where('ballotId', '==', doc.id)
      .get();
      
    ballots.push({
      id: doc.id,
      voteCount: votesSnap.size,
      ...data
    });
  }
  
  // Sort by vote count descending
  ballots.sort((a, b) => b.voteCount - a.voteCount);
  
  // Top 3-5 bills
  const topBallots = ballots.slice(0, 5);
  
  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  
  for (const ballot of topBallots) {
    const ref = db.collection('ballots').doc(ballot.id);
    batch.update(ref, { pinnedWeek: now });
  }
  
  await batch.commit();
  console.log(`Pinned ${topBallots.length} top bills.`);
}
