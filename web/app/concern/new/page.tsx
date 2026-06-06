'use client';
import { useState, useRef, useEffect } from 'react';
import { LocalLlmRouter, ChatMessage } from '../../../lib/localLlmRouter';
import { db, auth } from '../../../lib/firebaseClient';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { useRouter } from 'next/navigation';

export default function NewConcernPage() {
  const router = useRouter();
  const [entryMode, setEntryMode] = useState<'ai' | 'manual'>('ai');
  
  // AI Chat states
  const [chatMessages, setChatMessages] = useState<{ role: 'user'|'assistant'; text: string }[]>([
    { role: 'assistant', text: 'Hello! I am your AI Representative. What policy concerns or issues would you like to discuss today?' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmRoute, setLlmRoute] = useState<'ollama' | 'webgpu'>('ollama');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Manual & Edit/Review states
  const [manualTitle, setManualTitle] = useState('');
  const [manualDescription, setManualDescription] = useState('');
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewDescription, setPreviewDescription] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      let mode = LocalLlmRouter.getRouteMode() as any;
      if (mode === 'cloud') {
        mode = 'ollama';
        LocalLlmRouter.setRouteMode('ollama');
      }
      setLlmRoute(mode);
      
      const handleRoute = (e: any) => {
        setLlmRoute(e.detail);
      };
      window.addEventListener('csr-llm-route-changed', handleRoute);
      return () => window.removeEventListener('csr-llm-route-changed', handleRoute);
    }
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (entryMode === 'ai') {
      scrollToBottom();
    }
  }, [chatMessages, entryMode]);

  async function handleSend() {
    if (!chatInput.trim() || chatBusy) return;
    
    const userText = chatInput.trim();
    const nextMessages = [...chatMessages, { role: 'user' as const, text: userText }];
    const messagesWithPlaceholder = [...nextMessages, { role: 'assistant' as const, text: '' }];
    setChatMessages(messagesWithPlaceholder);
    setChatInput('');
    setChatBusy(true);
    setError(null);
    
    try {
      const systemPrompt = "You are a friendly, helpful AI Representative for the Common Sense Republic. Your job is to chat with the citizen, listen to their local policy concern, ask clarifying questions to understand the details, and help them formulate a clear policy request. Keep your replies concise and encouraging.";
      const routerHistory: ChatMessage[] = nextMessages.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text
      }));

      let responseText = '';
      const onTokenCallback = (token: string, full: string) => {
        setChatMessages(msgs => {
          const updated = [...msgs];
          if (updated.length > 0) {
            updated[updated.length - 1] = {
              role: 'assistant',
              text: full
            };
          }
          return updated;
        });
      };

      if (llmRoute === 'webgpu') {
        responseText = await LocalLlmRouter.generateWebGpuResponse(systemPrompt, routerHistory, userText, {
          onToken: onTokenCallback
        });
      } else {
        const ollamaModel = LocalLlmRouter.getOllamaModel();
        setError('Activating local AI representative...');
        await LocalLlmRouter.ensureOllamaActive(ollamaModel, (status) => {
          setError(status);
        });
        setError(null);
        responseText = await LocalLlmRouter.generateOllamaResponse(systemPrompt, routerHistory, userText, {
          stream: true,
          onToken: onTokenCallback
        });
      }

      setChatMessages(msgs => {
        const updated = [...msgs];
        if (updated.length > 0) {
          updated[updated.length - 1] = {
            role: 'assistant',
            text: responseText
          };
        }
        return updated;
      });
    } catch (err: any) {
      setError(err.message || 'Failed to send message');
      setChatMessages(msgs => {
        const updated = msgs.slice(0, -1);
        return [...updated, { role: 'assistant', text: 'Sorry, I encountered an error. Please check your local model setup and try again.' }];
      });
    } finally {
      setChatBusy(false);
    }
  }

  // Prepares the review preview dialog
  async function handleAIReview() {
    setChatBusy(true);
    setError(null);
    try {
      const systemPrompt = "You are a structured parser. Read the chat conversation and extract the citizen's core concern. Return a raw JSON object matching this schema: {\"title\": \"string (max 10 words)\", \"description\": \"string (clear summary of issue and desired policy fix)\"}. Do not include markdown code block wrappers.";
      const chatHistoryText = chatMessages.map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
      
      let extractionText = '';
      if (llmRoute === 'webgpu') {
        extractionText = await LocalLlmRouter.generateWebGpuResponse(systemPrompt, [], `Extract concern from this chat history:\n${chatHistoryText}`);
      } else {
        const ollamaModel = LocalLlmRouter.getOllamaModel();
        setError('Activating local AI parser...');
        await LocalLlmRouter.ensureOllamaActive(ollamaModel, (status) => {
          setError(status);
        });
        setError(null);
        extractionText = await LocalLlmRouter.generateOllamaResponse(systemPrompt, [], `Extract concern from this chat history:\n${chatHistoryText}`);
      }

      let title = 'Local Policy Concern';
      let description = 'Summary of conversation.';
      try {
        // Robust regex to extract JSON blocks even with surrounding garbage/conversational text
        const jsonMatch = extractionText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          title = parsed.title || title;
          description = parsed.description || description;
        } else {
          throw new Error("No JSON object structure found");
        }
      } catch {
        title = chatMessages.find(m => m.role === 'user')?.text.slice(0, 40) + '...' || title;
        description = chatMessages.map(m => m.text).join('\n');
      }

      setPreviewTitle(title);
      setPreviewDescription(description);
      setShowPreviewModal(true);
    } catch (err: any) {
      setError(err.message || 'Failed to parse chat history.');
    } finally {
      setChatBusy(false);
    }
  }

  async function handleFinalSubmit(title: string, desc: string) {
    const user = auth.currentUser;
    if (!user) {
      setError('You must be signed in to submit a concern.');
      return;
    }

    setChatBusy(true);
    setError(null);
    try {
      // Append raw chat history transcripts to preserve unfiltered citizen voices
      let finalDescription = desc.trim();
      if (entryMode === 'ai') {
        const transcript = chatMessages
          .filter(m => m.text.trim().length > 0)
          .map(m => `${m.role === 'user' ? 'Citizen' : 'AI Rep'}: ${m.text}`)
          .join('\n');
        finalDescription += `\n\n---\n### Raw Citizen-Representative Transcript\n\`\`\`text\n${transcript}\n\`\`\``;
      }

      const docRef = await addDoc(collection(db, 'concerns'), {
        title: title.trim(),
        description: finalDescription,
        authorUid: user.uid,
        jurisdiction: { country: 'US', state: 'OR', city: 'Winston' },
        topics: ['local'],
        status: 'idea',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        viewCount: 0,
        nominationCount: 0
      });

      setShowPreviewModal(false);
      router.push(`/concern/${docRef.id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to submit concern');
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto h-[82vh] flex flex-col">
      <div className="mb-4 flex flex-col sm:flex-row justify-between sm:items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Start a Policy Concern</h1>
          <p className="text-sm text-muted">Submit an issue to get neutral draft options and start a ballot.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setEntryMode('ai')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${entryMode === 'ai' ? 'bg-brand-navy text-white' : 'bg-gray-100 dark:bg-gray-800 text-muted'}`}
          >
            AI Representative Chat
          </button>
          <button
            onClick={() => setEntryMode('manual')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${entryMode === 'manual' ? 'bg-brand-navy text-white' : 'bg-gray-100 dark:bg-gray-800 text-muted'}`}
          >
            Direct Manual Form
          </button>
        </div>
      </div>

      {entryMode === 'ai' ? (
        <div className="flex-1 border rounded-lg bg-white dark:bg-black/20 shadow-sm overflow-hidden flex flex-col">
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="text-[10px] text-center text-muted uppercase tracking-wider border-b pb-2">
              Route: {llmRoute === 'ollama' ? '💻 Local Ollama' : '🔌 Browser WebGPU'}
            </div>
            {chatMessages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-2 ${m.role === 'user' ? 'bg-brand-navy text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100'}`}>
                  <p className="text-sm whitespace-pre-wrap">{m.text}</p>
                </div>
              </div>
            ))}
            {chatBusy && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100">
                  <p className="text-sm animate-pulse">Thinking...</p>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          
          <div className="p-3 border-t bg-gray-50 dark:bg-black/40">
            {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
            <div className="flex gap-2">
              <input 
                className="input flex-1" 
                value={chatInput} 
                onChange={e => setChatInput(e.target.value)} 
                onKeyDown={e => e.key === 'Enter' && handleSend()}
                placeholder="Type your concern here..." 
                disabled={chatBusy}
              />
              <button 
                onClick={handleSend} 
                disabled={chatBusy || !chatInput.trim()} 
                className="btn-primary px-6"
              >
                Send
              </button>
              {chatMessages.length > 1 && (
                <button
                  onClick={handleAIReview}
                  disabled={chatBusy}
                  className="btn-primary bg-emerald-600 hover:bg-emerald-500 px-4"
                >
                  Review & Publish
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 border rounded-lg bg-white dark:bg-black/20 shadow-sm p-6 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-xs font-bold mb-1">Policy Title</label>
            <input
              type="text"
              placeholder="e.g. Expand Downtown Bike Lanes"
              className="input w-full"
              value={manualTitle}
              onChange={e => setManualTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-bold mb-1">Description & Policy Fix</label>
            <textarea
              placeholder="Provide context and explain the desired outcome..."
              className="input w-full h-48"
              value={manualDescription}
              onChange={e => setManualDescription(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            onClick={() => handleFinalSubmit(manualTitle, manualDescription)}
            disabled={!manualTitle.trim() || !manualDescription.trim() || chatBusy}
            className="btn-primary w-full py-2.5"
          >
            Submit Concern Pool
          </button>
        </div>
      )}

      {/* Review Summary Modal */}
      {showPreviewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-gray-900 border rounded-3xl p-6 max-w-xl w-full space-y-4 shadow-xl">
            <h3 className="text-lg font-bold">Review Articulated Concern</h3>
            <p className="text-xs text-muted">Here is the summarized draft representing your discussion. You can tweak it before publishing.</p>
            
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold mb-1 text-muted">Suggested Title</label>
                <input
                  type="text"
                  className="input w-full"
                  value={previewTitle}
                  onChange={e => setPreviewTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-bold mb-1 text-muted">Summary / Proposed Fix</label>
                <textarea
                  className="input w-full h-40"
                  value={previewDescription}
                  onChange={e => setPreviewDescription(e.target.value)}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={() => setShowPreviewModal(false)}
                className="px-4 py-2 border rounded-xl"
              >
                Back
              </button>
              <button
                onClick={() => handleFinalSubmit(previewTitle, previewDescription)}
                disabled={chatBusy}
                className="btn-primary bg-emerald-600 hover:bg-emerald-500 px-5 rounded-xl"
              >
                Publish Pool
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
