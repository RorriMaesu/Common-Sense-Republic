import fetch from 'cross-fetch';
import 'dotenv/config';

async function testGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('No GEMINI_API_KEY found in environment');
    return;
  }

  const modelName = 'gemini-3-pro-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Hello, are you Gemini 3 Flash?' }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
  };

  console.log(`Testing model: ${modelName}`);
  const rResp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  
  if (!rResp.ok) {
    console.error(`Gemini API error: ${rResp.status} ${await rResp.text()}`);
    return;
  }
  
  const json: any = await rResp.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p: any)=> p.text).join('\n') || '';
  console.log('Response:', text);
}

testGemini();
