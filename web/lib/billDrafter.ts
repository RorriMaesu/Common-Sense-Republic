'use client';

import { collection, addDoc, doc, getDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebaseClient';
import { LocalLlmRouter } from './localLlmRouter';
import { createBallotSafe } from './functionsClient';

export interface SynthesizedBillResult {
  draftId: string;
  text: string;
  title: string;
}

export async function synthesizeConcernsToBill(
  concernIds: string[],
  options: {
    streamCallback?: (token: string, full: string) => void;
    progressCallback?: (stage: string, percent: number) => void;
  } = {}
): Promise<SynthesizedBillResult> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('You must be authenticated to synthesize concerns.');
  }

  if (concernIds.length === 0) {
    throw new Error('No concerns selected for synthesis.');
  }

  // 1. Fetch all concerns from Firestore
  if (options.progressCallback) options.progressCallback('Fetching concerns from database...', 10);
  const concernContents: string[] = [];
  let combinedTitles: string[] = [];
  let primaryJurisdiction = { country: 'US', state: 'OR', city: 'Winston' };

  for (const id of concernIds) {
    const docRef = doc(db, 'concerns', id);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data();
      combinedTitles.push(data.title || 'Untitled Concern');
      concernContents.push(`Concern Title: ${data.title}\nDescription: ${data.description}`);
      if (data.jurisdiction) {
        primaryJurisdiction = data.jurisdiction;
      }
    }
  }

  if (concernContents.length === 0) {
    throw new Error('No valid concerns found for the selected IDs.');
  }

  // 2. Formulate the prompt
  const systemPrompt = `You are the Legislative Drafter for the Common Sense Republic.
Your task is to review multiple user-submitted policy concerns, summarize their common themes, resolve minor conflicts in a common-sense manner, and compile them into a unified, formal legislative draft bill.

You must structure the draft bill in markdown with these exact headings:
# [Draft Bill Title]
## Preamble
## Conflicting Community Objectives
## Definitions
## Key Provisions
## Implementation & Funding Timeline
## Sunset & Review Clause

Under "Conflicting Community Objectives", explicitly detail any trade-offs, dissenting viewpoints, or competing priorities between the concerns (e.g. speed vs safety, cost vs comprehensiveness) to preserve minority viewpoints.`;

  const userPrompt = `Synthesize the following user concerns into a single legislative draft bill:

${concernContents.map((c, i) => `--- CONCERN ${i + 1} ---\n${c}`).join('\n\n')}

Provide the markdown text representing the drafted bill.`;

  // 3. Invoke LLM according to the selected Route Mode
  const mode = LocalLlmRouter.getRouteMode();
  let generatedText = '';

  if (options.progressCallback) options.progressCallback('Generating draft bill using AI...', 40);

  if (mode === 'webgpu') {
    generatedText = await LocalLlmRouter.generateWebGpuResponse(systemPrompt, [], userPrompt, {
      onToken: options.streamCallback,
      onProgress: options.progressCallback,
    });
  } else if (mode === 'ollama') {
    const ollamaModel = LocalLlmRouter.getOllamaModel();
    if (options.progressCallback) options.progressCallback('Activating local AI engine...', 40);
    await LocalLlmRouter.ensureOllamaActive(ollamaModel, (status) => {
      if (options.progressCallback) options.progressCallback(status, 45);
    });
    if (options.progressCallback) options.progressCallback('Generating draft bill...', 50);
    generatedText = await LocalLlmRouter.generateOllamaResponse(systemPrompt, [], userPrompt, {
      stream: true,
      onToken: options.streamCallback,
    });
  } else {
    // Cloud AI Fallback: Call standard cloud completion
    // Since we don't have a direct raw cloud fetch for arbitrary prompts in functionsClient, 
    // we use a fetch to Ollama or fail if offline/not configured.
    // For this prototype/MVP, we'll perform a client-side mock or fetch to Ollama.
    // In production, this would call a server-side Cloud Function twin.
    try {
      generatedText = await LocalLlmRouter.generateOllamaResponse(systemPrompt, [], userPrompt, {
        stream: true,
        onToken: options.streamCallback,
      });
    } catch {
      generatedText = `[Cloud AI Drafting Mode Simulator]
# Synthesized Public Directive: Local Civic Enhancements
## Preamble
This bill synthesizes the community concerns: ${combinedTitles.join(', ')}. It establishes a unified framework to address these issues immediately.
## Definitions
- Public Square: Any public right-of-way, municipal park, or digital forum operated by the jurisdiction.
## Key Provisions
- Community Taskforce: Established to implement improvements corresponding to: ${combinedTitles.map(t => `"${t}"`).join(', ')}.
## Implementation & Funding Timeline
- Funding: Supported via local civic grants and municipal allocations.
- Timeline: Effective within 90 days of passing.
## Sunset & Review Clause
- This policy remains active for 24 months, subject to audit and re-evaluation.`;
      if (options.streamCallback) {
        options.streamCallback(generatedText, generatedText);
      }
    }
  }

  // 4. Parse title from Markdown H1 if possible, otherwise build default
  if (options.progressCallback) options.progressCallback('Saving draft to database...', 90);
  let title = `Unified Proposal: ${combinedTitles.slice(0, 3).join(', ')}`;
  const titleMatch = generatedText.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // 5. Store Draft in Firestore
  const draftRef = await addDoc(collection(db, 'drafts'), {
    concernId: concernIds[0], // link to primary/first concern
    concernIds: concernIds,   // record full synthesis list
    version: 1,
    text: generatedText,
    title: title,
    authors: [{ uid: currentUser.uid, role: 'author' }],
    modelMeta: {
      model: mode === 'webgpu' ? LocalLlmRouter.getWebGpuModel() : LocalLlmRouter.getOllamaModel(),
      mode: mode,
    },
    citations: [],
    editHistory: [{ uid: currentUser.uid, changeSummary: 'Initial synthesis from concerns', ts: new Date() }],
    status: 'draft',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (options.progressCallback) options.progressCallback('Done!', 100);

  return {
    draftId: draftRef.id,
    text: generatedText,
    title,
  };
}
