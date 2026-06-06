import * as admin from 'firebase-admin';
import { getGeminiSettings } from './runtimeConfig';
import fetch from 'cross-fetch';

export async function runAgenticDrafter() {
  const db = admin.firestore();
  
  const summariesSnap = await db.collection('daily_summaries')
    .where('status', '==', 'pending_draft')
    .get();
    
  if (summariesSnap.empty) {
    console.log('No pending summaries to draft.');
    return;
  }
  
  const { geminiApiKey: apiKey, skipLLM } = getGeminiSettings();
  if (skipLLM) {
    console.log('Skipping LLM drafting.');
    return;
  }
  
  const modelName = 'gemini-2.5-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
  for (const doc of summariesSnap.docs) {
    const summary = doc.data();
    
    try {
      // Step 1: Drafting
      const draftPrompt = `You are an expert legislative drafter. Write a formal policy bill based on the following citizen concern summary.
Title: ${summary.title}
Summary: ${summary.summary}

Output the bill text in plain text.`;

      const draftBody = {
        contents: [ { role: 'user', parts: [{ text: draftPrompt }] } ],
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
      };

      const draftResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draftBody) });
      if (!draftResp.ok) throw new Error(`Drafting failed: ${draftResp.status}`);
      const draftJson: any = await draftResp.json();
      const initialDraft = draftJson?.candidates?.[0]?.content?.parts?.map((p: any)=> p.text).join('\n') || '';

      // Step 2: Critique
      const critiquePrompt = `Review the following legislative draft for loopholes, neutrality, and alignment with the original concern.
Original Concern: ${summary.summary}
Draft:
${initialDraft}

Provide a critique and suggest specific improvements.`;

      const critiqueBody = {
        contents: [ { role: 'user', parts: [{ text: critiquePrompt }] } ],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
      };

      const critiqueResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(critiqueBody) });
      if (!critiqueResp.ok) throw new Error(`Critique failed: ${critiqueResp.status}`);
      const critiqueJson: any = await critiqueResp.json();
      const critique = critiqueJson?.candidates?.[0]?.content?.parts?.map((p: any)=> p.text).join('\n') || '';

      // Step 3: Refinement
      const refinePrompt = `Revise the legislative draft based on the critique.
Original Draft:
${initialDraft}

Critique:
${critique}

Output EXACTLY a JSON object with this schema:
{
  "title": "Formal Bill Title",
  "text": "The final polished legislative text"
}`;

      const refineBody = {
        contents: [ { role: 'user', parts: [{ text: refinePrompt }] } ],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: 'application/json' }
      };

      const refineResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(refineBody) });
      if (!refineResp.ok) throw new Error(`Refinement failed: ${refineResp.status}`);
      const refineJson: any = await refineResp.json();
      const refineText = refineJson?.candidates?.[0]?.content?.parts?.map((p: any)=> p.text).join('\n') || '{}';
      
      const finalBill = JSON.parse(refineText);
      
      // Save to ballots
      const ballotRef = db.collection('ballots').doc();
      await ballotRef.set({
        concernId: doc.id, // Link to the daily summary
        title: finalBill.title,
        description: finalBill.text,
        status: 'open',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        options: [
          { id: 'yes', label: 'Yes', text: 'Approve this bill' },
          { id: 'no', label: 'No', text: 'Reject this bill' }
        ],
        tallyType: 'simple'
      });
      
      // Update summary status
      await doc.ref.update({ status: 'drafted', ballotId: ballotRef.id });
      
      console.log(`Drafted bill for summary ${doc.id}`);
    } catch (e) {
      console.error(`Failed to draft bill for summary ${doc.id}`, e);
    }
  }
}
