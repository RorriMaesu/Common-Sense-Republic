import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { getGeminiSettings } from './runtimeConfig';
import fetch from 'cross-fetch';

export async function runGeminiRepresentative(modelName: string, messages: any[], apiKey: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
  const systemInstruction = `You are an AI Representative for Common Sense Republic. Your job is to chat with citizens, understand their policy concerns, and help them articulate what they want changed in society.
Be conversational, empathetic, and ask clarifying questions.
Once you have a clear understanding of their concern (a clear problem and a desired outcome), you MUST output a JSON block at the very end of your response formatted exactly like this:
CONCERN_JSON: {"title": "A short title", "description": "A detailed description of the concern"}
Do not output this JSON until you are sure you understand the concern.`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }]
  }));

  // Prepend system instruction to the first user message
  if (contents.length > 0 && contents[0].role === 'user') {
    contents[0].parts[0].text = systemInstruction + '\n\n' + contents[0].parts[0].text;
  } else {
    contents.unshift({ role: 'user', parts: [{ text: systemInstruction }] });
  }

  const body = {
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
  };

  const rResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!rResp.ok) {
    throw new Error(`Gemini API error: ${rResp.status} ${await rResp.text()}`);
  }
  const json: any = await rResp.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p: any)=> p.text).join('\n') || '';
  
  let reply = text;
  let extractedConcern: { title: string; description: string } | null = null;
  
  const match = text.match(/CONCERN_JSON:\s*({.*})/s);
  if (match) {
    try {
      extractedConcern = JSON.parse(match[1]);
      reply = text.replace(match[0], '').trim();
    } catch (e) {
      console.error('Failed to parse CONCERN_JSON', e);
    }
  }
  
  return { reply, extractedConcern };
}
