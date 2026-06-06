'use client';

export const OLLAMA_BASE_URL = 'http://localhost:11434';

export interface ModelTier {
  id: string;
  name: string;
  shortName: string;
  description: string;
  url: string;
  filename: string;
  cacheVersion: string;
  expectedSize: number;
  ramRecommendation: string;
  tokensLimit: number;
}

export const MODEL_TIERS: Record<string, ModelTier> = {
  'smollm-135m-ultra': {
    id: 'smollm-135m-ultra',
    name: 'SmolLM2 Ultra-Light (135M)',
    shortName: 'Ultra-Light',
    description: 'Under 250MB, runs on 4GB RAM devices without crashing.',
    url: 'https://huggingface.co/litert-community/SmolLM2-135M-Instruct/resolve/main/SmolLM2_135M_Instruct.litertlm',
    filename: 'SmolLM2_135M_Instruct.litertlm',
    cacheVersion: 'smollm-135m-instruct-2026-05-31-r1',
    expectedSize: 135000000,
    ramRecommendation: '4GB RAM / Budget Devices',
    tokensLimit: 1024
  },
  'gemma-4-e2b': {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 Efficient (2.5B)',
    shortName: 'Efficient',
    description: 'Highly optimized for standard mobile and desktop environments.',
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
    filename: 'gemma-4-E2B-it-web.litertlm',
    cacheVersion: 'gemma-4-E2B-it-web-2026-05-30-r2',
    expectedSize: 2150000000,
    ramRecommendation: '4GB - 6GB+ RAM',
    tokensLimit: 1024
  },
  'gemma-4-e4b': {
    id: 'gemma-4-e4b',
    name: 'Gemma 4 Pro (4.5B)',
    shortName: 'Pro',
    description: 'Advanced logical reasoning and drafting capabilities. Needs higher memory.',
    url: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm',
    filename: 'gemma-4-E4B-it-web.litertlm',
    cacheVersion: 'gemma-4-E4B-it-web-2026-05-30-r2',
    expectedSize: 3190000000,
    ramRecommendation: '8GB+ RAM',
    tokensLimit: 2048
  }
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LocalLlmRouter {
  private static litertModule: any = null;
  private static activeEngine: any = null;
  private static activeConversation: any = null;
  private static lastSystemPrompt: string = '';
  private static idleTimer: any = null;

  static isBrowser() {
    return typeof window !== 'undefined';
  }

  static getRouteMode(): string {
    if (!this.isBrowser()) return 'ollama';
    return localStorage.getItem('csr_llm_route_mode') || 'ollama';
  }

  static setRouteMode(mode: 'ollama' | 'webgpu') {
    if (!this.isBrowser()) return;
    localStorage.setItem('csr_llm_route_mode', mode);
    window.dispatchEvent(new CustomEvent('csr-llm-route-changed', { detail: mode }));
  }

  static getOllamaModel(): string {
    if (!this.isBrowser()) return 'gemma4:e4b';
    return localStorage.getItem('csr_ollama_model') || 'gemma4:e4b';
  }

  static setOllamaModel(model: string) {
    if (!this.isBrowser()) return;
    localStorage.setItem('csr_ollama_model', model);
  }

  static getWebGpuModel(): string {
    if (!this.isBrowser()) return 'gemma-4-e2b';
    return localStorage.getItem('csr_webgpu_model') || 'gemma-4-e2b';
  }

  static setWebGpuModel(model: string) {
    if (!this.isBrowser()) return;
    localStorage.setItem('csr_webgpu_model', model);
  }

  static async checkOllamaStatus(): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  static async checkOllamaModelInstalled(modelName: string): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(1000) });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !Array.isArray(data.models)) return false;
      const target = modelName.toLowerCase();
      return data.models.some((m: any) => {
        const name = (m.name || '').toLowerCase();
        if (name === target) return true;
        if (!target.includes(':') && name === `${target}:latest`) return true;
        if (!name.includes(':') && target === `${name}:latest`) return true;
        return false;
      });
    } catch {
      return false;
    }
  }

  static async triggerOllamaLaunch(): Promise<boolean> {
    // 1. Try Python sidecar helper first
    try {
      const res = await fetch('http://localhost:8000/api/launch-ollama', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'launch' }),
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'success') return true;
      }
    } catch (err) {
      console.warn('[LocalLlmRouter] Sidecar API /api/launch-ollama call failed:', err);
    }

    // 2. Trigger OS Custom URL protocol scheme
    if (typeof window !== 'undefined') {
      try {
        console.log('[LocalLlmRouter] Triggering gnosys-ollama:// OS protocol handler...');
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = 'gnosys-ollama://launch';
        document.body.appendChild(iframe);
        setTimeout(() => iframe.remove(), 1000);
        return true;
      } catch (err) {
        console.warn('[LocalLlmRouter] OS protocol launch failed:', err);
      }
    }
    return false;
  }

  static async preloadOllamaModel(modelName: string): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, stream: false }),
        signal: AbortSignal.timeout(10000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  static async ensureOllamaActive(modelName: string, onStatusChange: (status: string) => void): Promise<void> {
    let online = await this.checkOllamaStatus();
    if (!online) {
      onStatusChange('Ollama offline. Launching background service...');
      await this.triggerOllamaLaunch();
      
      let connected = false;
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        onStatusChange(`Connecting to Ollama... (Attempt ${attempt}/${maxAttempts})`);
        await new Promise(r => setTimeout(r, 1500));
        online = await this.checkOllamaStatus();
        if (online) {
          connected = true;
          break;
        }
      }
      
      if (!connected) {
        throw new Error('Could not connect to Ollama automatically. Please open the Ollama app manually, or run "ollama serve" in your terminal.');
      }
    }

    onStatusChange('Verifying model installation...');
    const installed = await this.checkOllamaModelInstalled(modelName);
    if (!installed) {
      throw new Error(`Model "${modelName}" is not installed. Please open the AI settings (badge in header) and download it.`);
    }

    onStatusChange('Preloading model...');
    await this.preloadOllamaModel(modelName);
  }

  static async pullOllamaModel(modelName: string, onProgress: (percent: number, status: string) => void): Promise<void> {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: true }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Failed to initiate pull for ${modelName}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line);
          const status = payload.status || 'Downloading...';
          const completed = payload.completed || 0;
          const total = payload.total || 0;
          const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
          onProgress(percent, status);
        } catch {}
      }
    }
  }

  static async getHardwareInfo() {
    let ramGb = 8.0;
    let webGpuAvailable = false;
    if (this.isBrowser()) {
      ramGb = (navigator as any).deviceMemory || 8.0;
      webGpuAvailable = Boolean((navigator as any).gpu);
    }
    return { ramGb, webGpuAvailable };
  }

  static async generateOllamaResponse(
    systemPrompt: string,
    history: ChatMessage[],
    userPrompt: string,
    options: { model?: string; stream?: boolean; onToken?: (token: string, full: string) => void } = {}
  ): Promise<string> {
    const model = options.model || this.getOllamaModel();
    const messages: any[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: 'user', content: userPrompt });

    const requestOptions: any = {};
    if (model.toLowerCase().includes('gemma4') || model.toLowerCase().includes('gemma-4')) {
      requestOptions.draft_num_predict = 4; // Speculative multi-token prediction for Gemma 4
    }

    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: Boolean(options.stream),
        options: requestOptions,
      })
    });

    if (!res.ok) {
      throw new Error(`Ollama Chat Error: ${res.statusText}`);
    }

    if (!options.stream) {
      const data = await res.json();
      return data?.message?.content || data?.response || '';
    }

    if (!res.body) {
      throw new Error('Readable stream not supported.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const token = data?.message?.content || '';
          if (token) {
            fullText += token;
            if (options.onToken) {
              options.onToken(token, fullText);
            }
          }
        } catch {}
      }
    }

    return fullText;
  }

  // WebGPU / LiteRT-LM Local Inference
  static async loadWebGpuEngine(onProgress?: (stage: string, percent: number) => void): Promise<any> {
    if (this.activeEngine) return this.activeEngine;

    if (!this.litertModule) {
      if (onProgress) onProgress('Loading core dependencies...', 10);
      this.litertModule = await new Function("return import('https://cdn.jsdelivr.net/npm/@litert-lm/core/+esm')")();
    }

    const configId = this.getWebGpuModel();
    const tier = MODEL_TIERS[configId] || MODEL_TIERS['gemma-4-e2b'];

    if (onProgress) onProgress('Checking model database...', 30);
    const modelFile = await this.getOpfsModelFile(tier.filename);
    if (!modelFile || modelFile.size !== tier.expectedSize) {
      if (onProgress) onProgress('Downloading browser model... (takes a moment)', 40);
      await this.downloadModelToOpfs(tier, (percent) => {
        if (onProgress) onProgress(`Downloading model: ${percent}%`, 40 + percent * 0.4);
      });
    }

    if (onProgress) onProgress('Initializing WebGPU pipeline...', 85);
    const { Engine, Backend } = this.litertModule;
    
    // virtual local scope URL so Next.js service worker can intercept or direct URL creation
    const opfsFile = await this.getOpfsModelFile(tier.filename);
    if (!opfsFile) throw new Error('OPFS Model File not found after download.');
    const modelUrl = URL.createObjectURL(opfsFile);

    const engineSettings = {
      model: modelUrl,
      backend: Backend ? Backend.GPU_ARTISAN : undefined,
      mainExecutorSettings: {
        maxNumTokens: tier.tokensLimit,
      },
    };

    try {
      this.activeEngine = await Engine.create(engineSettings);
      this.setupMemoryManagement();
      if (onProgress) onProgress('Local Model ready!', 100);
      return this.activeEngine;
    } catch (err) {
      console.warn('WebGPU engine failed, trying CPU fallback...', err);
      if (Backend && Backend.CPU) {
        engineSettings.backend = Backend.CPU;
        this.activeEngine = await Engine.create(engineSettings);
        if (onProgress) onProgress('Local Model ready (CPU Fallback)!', 100);
        return this.activeEngine;
      }
      throw err;
    }
  }

  private static setupMemoryManagement() {
    if (!this.isBrowser()) return;
    
    // Visibility listener to deallocate VRAM if page is hidden
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'hidden' && this.activeEngine) {
        console.log('[LocalLlmRouter] Tab hidden. Clearing VRAM assets.');
        await this.closeWebGpuSession();
      }
    });

    this.resetIdleTimer();
  }

  private static resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      console.log('[LocalLlmRouter] Idle timeout. Releasing WebGPU memory.');
      await this.closeWebGpuSession();
    }, 180000); // 3 minutes
  }

  static async closeWebGpuSession() {
    if (this.activeEngine) {
      try {
        await this.activeEngine.delete();
      } catch {}
      this.activeEngine = null;
    }
    this.activeConversation = null;
  }

  static async generateWebGpuResponse(
    systemPrompt: string,
    history: ChatMessage[],
    userPrompt: string,
    options: { onToken?: (token: string, full: string) => void; onProgress?: (stage: string, percent: number) => void } = {}
  ): Promise<string> {
    const engine = await this.loadWebGpuEngine(options.onProgress);
    this.resetIdleTimer();

    // Set up or reuse conversation session
    if (!this.activeConversation || this.lastSystemPrompt !== systemPrompt) {
      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      for (const item of history) {
        messages.push({ role: item.role, content: item.content });
      }

      this.activeConversation = await engine.createConversation({
        preface: { messages }
      });
      this.lastSystemPrompt = systemPrompt;
    }

    const streamSource = this.activeConversation.sendMessageStreaming({ role: 'user', content: userPrompt });
    let text = '';

    for await (const chunk of streamSource) {
      if (chunk && Array.isArray(chunk.content)) {
        for (const item of chunk.content) {
          if (item && item.type === 'text' && typeof item.text === 'string') {
            text += item.text;
            if (options.onToken) {
              options.onToken(item.text, text);
            }
          }
        }
      }
    }

    return text;
  }

  // Helper storage routines
  private static async getOpfsRoot() {
    if (!this.isBrowser() || !navigator.storage?.getDirectory) {
      throw new Error('OPFS is unavailable in this environment.');
    }
    return navigator.storage.getDirectory();
  }

  private static async getOpfsModelFile(filename: string): Promise<File | null> {
    try {
      const root = await this.getOpfsRoot();
      const handle = await root.getFileHandle(filename, { create: false });
      return await handle.getFile();
    } catch {
      return null;
    }
  }

  private static async downloadModelToOpfs(tier: ModelTier, onProgress: (percent: number) => void): Promise<void> {
    const root = await this.getOpfsRoot();
    const res = await fetch(tier.url);
    if (!res.ok || !res.body) throw new Error('Model download stream failed.');

    const handle = await root.getFileHandle(tier.filename, { create: true });
    const writable = await handle.createWritable();
    const reader = res.body.getReader();
    const total = tier.expectedSize;
    let loaded = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        loaded += value.byteLength;
        await writable.write(value);
        onProgress(Math.round((loaded / total) * 100));
      }
      await writable.close();
    } catch (err) {
      await writable.abort();
      throw err;
    }
  }

  static async purgeWebGpuStorage() {
    await this.closeWebGpuSession();
    const root = await this.getOpfsRoot();
    for (const key of Object.keys(MODEL_TIERS)) {
      try {
        await root.removeEntry(MODEL_TIERS[key].filename);
      } catch {}
    }
  }
}
