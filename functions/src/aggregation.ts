import * as admin from 'firebase-admin';
import { getGeminiSettings } from './runtimeConfig';
import fetch from 'cross-fetch';

export async function runDailyAggregation() {
  const db = admin.firestore();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  const concernsSnap = await db.collection('concerns')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(yesterday))
    .get();
    
  if (concernsSnap.empty) {
    console.log('No new concerns to aggregate.');
    return;
  }
  
  const concerns = concernsSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
  
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
  if (skipLLM) {
    console.log('Skipping LLM aggregation.');
    return;
  }
  
  const modelName = 'gemini-2.5-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
  const prompt = `You are an expert policy analyst. Review the following citizen concerns submitted in the last 24 hours.
Cluster similar concerns together into broader policy topics.
For each cluster, provide a title, a summary of the problem, and a list of the original concern IDs that belong to this cluster.
Output EXACTLY a JSON array of objects with this schema:
[
  {
    "title": "Cluster Title",
    "summary": "Detailed summary of the clustered concerns",
    "concernIds": ["id1", "id2"]
  }
]

Concerns:
${JSON.stringify(concerns.map(c => ({ id: c.id, title: c.title, description: c.description })), null, 2)}
`;

  const body = {
    contents: [ { role: 'user', parts: [{ text: prompt }] } ],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: 'application/json' }
  };

  const rResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!rResp.ok) {
    throw new Error(`Gemini API error: ${rResp.status} ${await rResp.text()}`);
  }
  
  const json: any = await rResp.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p: any)=> p.text).join('\n') || '[]';
  
  let clusters: any[] = [];
  try {
    clusters = JSON.parse(text);
  } catch (e) {
    console.error('Failed to parse aggregation JSON', e);
    return;
  }
  
  const batch = db.batch();
  for (const cluster of clusters) {
    const ref = db.collection('daily_summaries').doc();
    batch.set(ref, {
      ...cluster,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending_draft'
    });
  }
  
  await batch.commit();
  console.log(`Aggregated ${concerns.length} concerns into ${clusters.length} clusters.`);
}
