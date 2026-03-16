const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const fetch   = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const anthropicProvider = require('./providers/anthropic');
const openaiProvider    = require('./providers/openai');
const geminiProvider    = require('./providers/gemini');
const ollamaProvider    = require('./providers/ollama');
const imageConverter    = require('./converters/image');
const pdfConverter      = require('./converters/pdf');
const { buildDocx }     = require('./output/docx');

const PORT     = process.env.PORT || 3444;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'ocr_jobs.json');

// ── Providers ──────────────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic: anthropicProvider,
  openai:    openaiProvider,
  gemini:    geminiProvider,
  ollama:    ollamaProvider,
};

// ── Pricing (USD per 1M tokens) ────────────────────────────────────────────
// Vision token estimate: a 1000x1000 PNG ≈ 1500 input tokens (rough average)
// Output for OCR is typically 500–2000 tokens per page
const PRICING = {
  anthropic: {
    'claude-sonnet-4-6':           { input: 3.00,  output: 15.00 },
    'claude-opus-4-5':             { input: 15.00, output: 75.00 },
    'claude-haiku-4-5-20251001':   { input: 0.80,  output: 4.00  },
  },
  openai: {
    'gpt-4o':      { input: 2.50,  output: 10.00 },
    'gpt-4o-mini': { input: 0.15,  output: 0.60  },
  },
  gemini: {
    'gemini-1.5-pro':   { input: 1.25, output: 5.00 },
    'gemini-1.5-flash': { input: 0.075,output: 0.30 },
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  },
  ollama: {},  // free / local
};

// Image token estimate: base64 length → raw bytes → approx tokens
// Vision models consume roughly 1 token per 6 bytes of image data (heuristic)
function estimateImageTokens(base64str) {
  const bytes = Math.floor((base64str || '').length * 0.75);
  return Math.ceil(bytes / 400); // ≈ 1 token per 400 bytes is a safe estimate
}

// ── Fatal error detection ──────────────────────────────────────────────────
const FATAL_PATTERNS = [
  'invalid api key', 'incorrect api key', 'authentication', 'authorization',
  'billing', 'quota', 'insufficient_quota', 'disabled', 'deactivated',
  'account_deactivated', 'access_terminated',
];
function isFatal(msg) {
  const lower = (msg || '').toLowerCase();
  return FATAL_PATTERNS.some(p => lower.includes(p));
}

// ── DB helpers ─────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_PATH)) return { jobs: {} };
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { jobs: {} }; }
}
function saveDB(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── RTL language detection ──────────────────────────────────────────────────
const RTL_LANGS = ['arabic', 'hebrew', 'persian', 'farsi', 'urdu', 'pashto', 'yiddish', 'ar', 'he', 'fa', 'ur', 'ps', 'yi'];
function isRTLLanguage(lang) {
  if (!lang) return false;
  return RTL_LANGS.some(r => lang.toLowerCase().includes(r));
}
function detectRTLFromText(text) {
  if (!text) return false;
  const rtlChars  = (text.match(/[\u0600-\u06FF\u0590-\u05FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const allChars  = text.replace(/[\s\d.,!?]/g, '').length;
  return allChars > 20 && rtlChars / allChars > 0.3;
}

// ── OCR prompt builder ─────────────────────────────────────────────────────
function buildOCRPrompt(language, customPrompt, pageIndex, pageCount) {
  if (customPrompt) return customPrompt;
  const langHint   = language ? ` The document is written in ${language}.` : ' Auto-detect the language of the text.';
  const pageHint   = pageCount > 1 ? ` This is page ${pageIndex + 1} of ${pageCount}.` : '';
  return `You are a professional OCR (Optical Character Recognition) system.${langHint}${pageHint} Extract ALL text from this image exactly as it appears. Preserve the original layout, line breaks, paragraph spacing, indentation, and structural formatting as faithfully as possible. Output ONLY the extracted text — no commentary, no descriptions, no metadata. If the image contains no readable text, output an empty string.`;
}

// ── Language detection prompt ──────────────────────────────────────────────
function buildDetectPrompt() {
  return `Look at this image and identify the primary language of the text. Reply with ONLY a JSON object in this exact format: {"language":"English","rtl":false}. Set rtl to true for Arabic, Hebrew, Persian, Urdu, etc. Use the full English language name.`;
}

// ── Express setup ──────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ── Upload & convert ───────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext       = path.extname(req.file.originalname).toLowerCase();
    const supported = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp', '.pdf'];
    if (!supported.includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Unsupported format: ${ext}` });
    }

    const pages = ext === '.pdf'
      ? await pdfConverter.toPages(req.file.path)
      : await imageConverter.toPages(req.file.path, ext);

    fs.unlinkSync(req.file.path);

    // Calculate total base64 size for cost estimation
    const totalBase64Bytes = pages.reduce((sum, p) => sum + (p.imageBase64 || '').length, 0);

    const jobId = uuidv4();
    const db    = loadDB();
    db.jobs[jobId] = {
      id:              jobId,
      originalName:    req.file.originalname,
      uploadedAt:      new Date().toISOString(),
      status:          'uploaded',
      pageCount:       pages.length,
      totalBase64Bytes,
      pages:           pages.map(p => ({
        index:       p.index,
        imageBase64: p.imageBase64,
        status:      'pending',
        error:       null,
      })),
      ocrResults:  new Array(pages.length).fill(null),
      config:      null,
      fatalError:  null,
      detectedLang: null,
      rtl:         false,
    };
    saveDB(db);

    res.json({ jobId, pageCount: pages.length, filename: req.file.originalname, totalBase64Bytes });
  } catch (err) {
    console.error('Upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-detect language ───────────────────────────────────────────────────
app.post('/api/detect-language', async (req, res) => {
  const { jobId, provider, model, apiKey, ollamaBaseUrl } = req.body;
  const db  = loadDB();
  const job = db.jobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Invalid provider' });

  // Use the first page image for detection
  const firstPage = job.pages[0];
  if (!firstPage) return res.status(400).json({ error: 'No pages found' });

  try {
    const raw = await PROVIDERS[provider].ocr({
      apiKey,
      model,
      imageBase64: firstPage.imageBase64,
      prompt:      buildDetectPrompt(),
      baseUrl:     ollamaBaseUrl,
    });

    // Parse JSON response — try strict parse first, then regex extraction
    let language = null, rtl = false;
    try {
      const match  = raw.match(/\{[^}]+\}/);
      const parsed = JSON.parse(match ? match[0] : raw);
      language = parsed.language || null;
      rtl      = parsed.rtl      || isRTLLanguage(parsed.language) || false;
    } catch {
      // Fallback: just grab the first word as language
      language = raw.trim().split(/[\s,{}"]/)[0] || null;
      rtl      = isRTLLanguage(language);
    }

    // Save to job
    db.jobs[jobId].detectedLang = language;
    db.jobs[jobId].rtl          = rtl;
    saveDB(db);

    res.json({ language, rtl });
  } catch (err) {
    res.json({ language: null, rtl: false, error: err.message });
  }
});

// ── Cost estimator ─────────────────────────────────────────────────────────
app.post('/api/estimate', (req, res) => {
  const { jobId, provider, model } = req.body;
  const db  = loadDB();
  const job = db.jobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (provider === 'ollama') {
    return res.json({ provider, model, free: true, label: 'Free (local)' });
  }

  const pricing = PRICING[provider]?.[model];
  if (!pricing) {
    return res.json({ provider, model, free: false, label: 'Pricing unavailable for this model' });
  }

  // Per page: estimate input tokens from image size + fixed prompt tokens (~100)
  // Estimate output: avg 800 tokens per page for OCR output
  const PROMPT_TOKENS   = 100;
  const OUTPUT_PER_PAGE = 800;

  let totalInputTokens  = 0;
  let totalOutputTokens = 0;

  for (const page of job.pages) {
    const imgTokens = estimateImageTokens(page.imageBase64);
    totalInputTokens  += imgTokens + PROMPT_TOKENS;
    totalOutputTokens += OUTPUT_PER_PAGE;
  }

  const inputCost  = (totalInputTokens  / 1_000_000) * pricing.input;
  const outputCost = (totalOutputTokens / 1_000_000) * pricing.output;
  const totalCost  = inputCost + outputCost;

  const fmt = n => n < 0.01 ? '< $0.01' : `$${n.toFixed(3)}`;

  res.json({
    provider,
    model,
    free:               false,
    pageCount:          job.pageCount,
    totalInputTokens,
    totalOutputTokens,
    inputCost:          inputCost.toFixed(4),
    outputCost:         outputCost.toFixed(4),
    totalCost:          totalCost.toFixed(4),
    label:              fmt(totalCost),
    breakdown:          `~${totalInputTokens.toLocaleString()} input + ~${totalOutputTokens.toLocaleString()} output tokens`,
  });
});

// ── Start OCR (with chunked parallel processing) ───────────────────────────
app.post('/api/ocr', async (req, res) => {
  const { jobId, provider, model, apiKey, language, customPrompt, ollamaBaseUrl, concurrency } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!provider || !PROVIDERS[provider]) return res.status(400).json({ error: 'Invalid provider' });

  const db  = loadDB();
  const job = db.jobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'processing') return res.status(400).json({ error: 'Already processing' });

  // Use detected language if none provided
  const effectiveLang = language || job.detectedLang || null;

  // Concurrency: how many pages to process in parallel
  // Ollama = 1 (single local GPU), cloud APIs = up to 5
  const maxConcurrent = Math.min(
    Math.max(1, parseInt(concurrency) || (provider === 'ollama' ? 1 : 3)),
    provider === 'ollama' ? 2 : 5
  );

  job.status = 'processing';
  job.config = { provider, model, language: effectiveLang, customPrompt, ollamaBaseUrl, concurrency: maxConcurrent };
  saveDB(db);

  res.json({ jobId, pageCount: job.pageCount, concurrency: maxConcurrent });

  // ── Chunked parallel OCR loop ──────────────────────────────────────────
  (async () => {
    const indices = Array.from({ length: job.pageCount }, (_, i) => i);

    // Process in chunks of maxConcurrent
    for (let chunkStart = 0; chunkStart < indices.length; chunkStart += maxConcurrent) {
      // Check for cancellation before each chunk
      const dbCheck = loadDB();
      if (dbCheck.jobs[jobId]?.status === 'cancelled') break;
      if (dbCheck.jobs[jobId]?.fatalError) break;

      const chunk = indices.slice(chunkStart, chunkStart + maxConcurrent);

      // Mark all pages in chunk as processing
      const dbMark = loadDB();
      for (const i of chunk) {
        if (dbMark.jobs[jobId].pages[i].status === 'pending') {
          dbMark.jobs[jobId].pages[i].status = 'processing';
        }
      }
      saveDB(dbMark);

      // Run chunk in parallel
      await Promise.all(chunk.map(async (i) => {
        const dbNow = loadDB();
        if (dbNow.jobs[jobId]?.status === 'cancelled') return;

        const prompt      = buildOCRPrompt(effectiveLang, customPrompt, i, job.pageCount);
        const imageBase64 = job.pages[i].imageBase64;

        try {
          const text = await PROVIDERS[provider].ocr({
            apiKey,
            model,
            imageBase64,
            prompt,
            baseUrl: ollamaBaseUrl,
          });

          const db2 = loadDB();
          db2.jobs[jobId].pages[i].status  = 'done';
          db2.jobs[jobId].ocrResults[i]    = text;

          // Auto-detect RTL from first page if not already known
          if (i === 0 && !db2.jobs[jobId].detectedLang) {
            if (detectRTLFromText(text)) db2.jobs[jobId].rtl = true;
          }

          const doneCount = db2.jobs[jobId].pages.filter(p => p.status === 'done').length;
          if (doneCount === db2.jobs[jobId].pageCount) db2.jobs[jobId].status = 'done';
          saveDB(db2);

        } catch (err) {
          console.error(`OCR page ${i} error:`, err.message);
          const db2 = loadDB();
          db2.jobs[jobId].pages[i].status = 'failed';
          db2.jobs[jobId].pages[i].error  = err.message;

          if (isFatal(err.message)) {
            db2.jobs[jobId].status     = 'failed';
            db2.jobs[jobId].fatalError = err.message;
          } else {
            const allFinished = db2.jobs[jobId].pages.every(p => p.status === 'done' || p.status === 'failed');
            if (allFinished) db2.jobs[jobId].status = 'failed';
          }
          saveDB(db2);
        }
      }));

      // If a fatal error occurred, stop processing
      const dbAfter = loadDB();
      if (dbAfter.jobs[jobId]?.fatalError) break;
    }
  })();
});

// ── Status polling ────────────────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });

  const done   = job.pages.filter(p => p.status === 'done').length;
  const failed = job.pages.filter(p => p.status === 'failed').length;
  const total  = job.pageCount;

  res.json({
    status:       job.status,
    progress:     total > 0 ? Math.round(((done + failed) / total) * 100) : 0,
    done,
    failed,
    total,
    fatalError:   job.fatalError || null,
    rtl:          job.rtl || false,
    detectedLang: job.detectedLang || null,
    concurrency:  job.config?.concurrency || 1,
    pages:        job.pages.map(p => ({ index: p.index, status: p.status, error: p.error })),
  });
});

// ── Full result ────────────────────────────────────────────────────────────
app.get('/api/result/:jobId', (req, res) => {
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });

  res.json({
    jobId:        job.id,
    originalName: job.originalName,
    status:       job.status,
    pageCount:    job.pageCount,
    rtl:          job.rtl || false,
    detectedLang: job.detectedLang || null,
    pages:        job.ocrResults.map((text, i) => ({
      index:  i,
      text:   text || '',
      status: job.pages[i].status,
      error:  job.pages[i].error,
    })),
    fullText: job.ocrResults.map((t, i) =>
      job.pageCount > 1 ? `=== Page ${i + 1} ===\n${t || ''}` : (t || '')
    ).join('\n\n'),
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────
app.post('/api/cancel/:jobId', (req, res) => {
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'processing') return res.status(400).json({ error: 'Not processing' });
  db.jobs[req.params.jobId].status = 'cancelled';
  saveDB(db);
  res.json({ ok: true });
});

// ── Retry failed pages ─────────────────────────────────────────────────────
app.post('/api/retry/:jobId', async (req, res) => {
  const { provider, model, apiKey, language, ollamaBaseUrl } = req.body;
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });

  const failedPages = job.pages.filter(p => p.status === 'failed');
  if (!failedPages.length) return res.status(400).json({ error: 'No failed pages' });

  failedPages.forEach(p => { p.status = 'pending'; p.error = null; });
  job.status     = 'processing';
  job.fatalError = null;
  if (provider) job.config = { ...job.config, provider, model, ollamaBaseUrl };
  saveDB(db);

  res.json({ jobId: job.id, retrying: failedPages.length });

  const cfg        = job.config;
  const useLang    = language || cfg.language || job.detectedLang;
  const concurrent = cfg.concurrency || (provider === 'ollama' ? 1 : 3);

  (async () => {
    for (let i = 0; i < failedPages.length; i += concurrent) {
      const chunk = failedPages.slice(i, i + concurrent);
      const dbChk = loadDB();
      if (dbChk.jobs[job.id]?.status === 'cancelled') break;

      await Promise.all(chunk.map(async (page) => {
        const prompt = buildOCRPrompt(useLang, cfg.customPrompt, page.index, job.pageCount);
        try {
          const text = await PROVIDERS[cfg.provider || provider].ocr({
            apiKey:      apiKey || cfg.apiKey,
            model:       cfg.model || model,
            imageBase64: job.pages[page.index].imageBase64,
            prompt,
            baseUrl:     cfg.ollamaBaseUrl || ollamaBaseUrl,
          });
          const db2 = loadDB();
          db2.jobs[job.id].pages[page.index].status = 'done';
          db2.jobs[job.id].ocrResults[page.index]   = text;
          const doneCount = db2.jobs[job.id].pages.filter(p => p.status === 'done').length;
          if (doneCount === db2.jobs[job.id].pageCount) db2.jobs[job.id].status = 'done';
          saveDB(db2);
        } catch (err) {
          const db2 = loadDB();
          db2.jobs[job.id].pages[page.index].status = 'failed';
          db2.jobs[job.id].pages[page.index].error  = err.message;
          if (isFatal(err.message)) { db2.jobs[job.id].status = 'failed'; db2.jobs[job.id].fatalError = err.message; }
          saveDB(db2);
        }
      }));

      if (loadDB().jobs[job.id]?.fatalError) break;
    }
  })();
});

// ── Downloads ─────────────────────────────────────────────────────────────
app.get('/api/download/:jobId/txt', (req, res) => {
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });
  const text = job.ocrResults.map((t, i) =>
    job.pageCount > 1 ? `=== Page ${i + 1} ===\n${t || ''}` : (t || '')
  ).join('\n\n');
  const base = path.basename(job.originalName, path.extname(job.originalName));
  res.setHeader('Content-Disposition', `attachment; filename="${base}_ocr.txt"`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(text);
});

app.get('/api/download/:jobId/docx', async (req, res) => {
  try {
    const db  = loadDB();
    const job = db.jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Not found' });
    const pages  = job.ocrResults.map((t, i) => ({ index: i, text: t || '' }));
    const buffer = await buildDocx(job.originalName, pages);
    const base   = path.basename(job.originalName, path.extname(job.originalName));
    res.setHeader('Content-Disposition', `attachment; filename="${base}_ocr.docx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Job management ────────────────────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  const db   = loadDB();
  const jobs = Object.values(db.jobs)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .map(j => ({
      id:           j.id,
      originalName: j.originalName,
      uploadedAt:   j.uploadedAt,
      status:       j.status,
      pageCount:    j.pageCount,
      provider:     j.config?.provider,
      detectedLang: j.detectedLang || null,
    }));
  res.json({ jobs });
});

app.delete('/api/jobs/:jobId', (req, res) => {
  const db = loadDB();
  if (!db.jobs[req.params.jobId]) return res.status(404).json({ error: 'Not found' });
  delete db.jobs[req.params.jobId];
  saveDB(db);
  res.json({ ok: true });
});

// ── Ollama model list ─────────────────────────────────────────────────────
app.get('/api/ollama/models', async (req, res) => {
  const baseUrl    = req.query.baseUrl || 'http://localhost:11434';
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data   = await r.json();
    const models = (data.models || []).map(m => ({
      name:     m.name,
      size:     m.size,
      isVision: /llava|moondream|bakllava|vision|minicpm|qwen.*vl|phi.*vision|cogvlm/i.test(m.name),
    }));
    res.json({ models });
  } catch (err) {
    clearTimeout(timer);
    res.json({ models: [], error: 'Ollama not running or not accessible at ' + baseUrl });
  }
});

// ── Test API key ──────────────────────────────────────────────────────────
app.post('/api/test-key', async (req, res) => {
  const { provider, model, apiKey, baseUrl } = req.body;
  const providerModule = PROVIDERS[provider];
  if (!providerModule) return res.status(400).json({ ok: false, error: 'Unknown provider' });
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
  try {
    await providerModule.ocr({ apiKey, model, imageBase64: TINY_PNG, prompt: 'Reply with the single word: ok', baseUrl });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Serve UI ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`OCR Desktop server running on http://localhost:${PORT}`));
