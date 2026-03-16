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

const PORT    = process.env.PORT || 3444;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'ocr_jobs.json');

// ── Providers ──────────────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic: anthropicProvider,
  openai:    openaiProvider,
  gemini:    geminiProvider,
  ollama:    ollamaProvider,
};

// ── Fatal error detection ──────────────────────────────────────────────────
const FATAL_PATTERNS = [
  'invalid api key', 'incorrect api key', 'authentication', 'authorization',
  'billing', 'quota', 'insufficient_quota', 'disabled', 'deactivated',
  'account_deactivated', 'access_terminated',
];

function isFatal(errMsg) {
  const lower = (errMsg || '').toLowerCase();
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
const RTL_LANGS = ['arabic', 'hebrew', 'persian', 'farsi', 'urdu', 'pashto', 'yiddish', 'divehi', 'ar', 'he', 'fa', 'ur', 'ps', 'yi', 'dv'];

function isRTLLanguage(lang) {
  if (!lang) return false;
  return RTL_LANGS.some(r => lang.toLowerCase().includes(r));
}

// ── OCR prompt builder ─────────────────────────────────────────────────────
function buildOCRPrompt(language, customPrompt, pageIndex, pageCount) {
  if (customPrompt) return customPrompt;
  const langHint  = language ? ` The document is written in ${language}.` : '';
  const pageHint  = pageCount > 1 ? ` This is page ${pageIndex + 1} of ${pageCount}.` : '';
  const autoDetect = !language ? ' Auto-detect the language of the text.' : '';
  return `You are a professional OCR (Optical Character Recognition) system.${langHint}${autoDetect}${pageHint} Extract ALL text from this image exactly as it appears. Preserve the original layout, line breaks, paragraph spacing, indentation, and structural formatting (bold, italic, headings, lists, tables) as faithfully as possible using plain text approximations (e.g. use ALL CAPS or *asterisks* for bold, # for headings, | for table columns). Preserve the original reading direction and text alignment. Output ONLY the extracted text — no commentary, no descriptions, no metadata. If the image contains no readable text, output an empty string.`;
}

// ── Auto-detect language from first page OCR result ─────────────────────────
async function detectLanguageFromText(provider, model, apiKey, text, ollamaBaseUrl) {
  if (!text || text.length < 20) return null;
  const sample = text.slice(0, 500);
  const prompt = `Identify the language of this text. Reply with ONLY the language name in English (e.g. "Arabic", "French", "Chinese Simplified"). Text: "${sample}"`;
  try {
    const result = await PROVIDERS[provider].ocr({
      apiKey,
      model,
      imageBase64: null, // text-only detection uses a tiny white image trick
      prompt,
      baseUrl: ollamaBaseUrl,
    });
    return result.trim().split('\n')[0].replace(/[^a-zA-Z\s]/g, '').trim() || null;
  } catch {
    return null;
  }
}

// ── Express setup ──────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// ── Upload & convert ───────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    const supported = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp', '.pdf'];
    if (!supported.includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Unsupported format: ${ext}. Supported: ${supported.join(', ')}` });
    }

    let pages;
    if (ext === '.pdf') {
      pages = await pdfConverter.toPages(req.file.path);
    } else {
      pages = await imageConverter.toPages(req.file.path, ext);
    }

    // Clean up temp upload file
    fs.unlinkSync(req.file.path);

    const jobId = uuidv4();
    const db = loadDB();
    db.jobs[jobId] = {
      id:           jobId,
      originalName: req.file.originalname,
      uploadedAt:   new Date().toISOString(),
      status:       'uploaded',
      pageCount:    pages.length,
      pages:        pages.map(p => ({
        index:       p.index,
        imageBase64: p.imageBase64,
        status:      'pending',
        error:       null,
      })),
      ocrResults:   new Array(pages.length).fill(null),
      config:       null,
      fatalError:   null,
    };
    saveDB(db);

    res.json({ jobId, pageCount: pages.length, filename: req.file.originalname });
  } catch (err) {
    console.error('Upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ── Start OCR ─────────────────────────────────────────────────────────────
app.post('/api/ocr', async (req, res) => {
  const { jobId, provider, model, apiKey, language, customPrompt, ollamaBaseUrl } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!provider || !PROVIDERS[provider]) return res.status(400).json({ error: 'Invalid provider' });

  const db = loadDB();
  const job = db.jobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'processing') return res.status(400).json({ error: 'Already processing' });

  job.status = 'processing';
  job.config = { provider, model, language, customPrompt, ollamaBaseUrl };
  saveDB(db);

  // Respond immediately — OCR runs in background
  res.json({ jobId, pageCount: job.pageCount });

  // ── Async OCR loop ────────────────────────────────────────────────────
  (async () => {
    for (let i = 0; i < job.pageCount; i++) {
      const dbNow = loadDB();
      const jobNow = dbNow.jobs[jobId];
      if (!jobNow || jobNow.status === 'cancelled') break;

      // Mark page processing
      dbNow.jobs[jobId].pages[i].status = 'processing';
      saveDB(dbNow);

      const prompt = buildOCRPrompt(language, customPrompt, i, job.pageCount);
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
        db2.jobs[jobId].pages[i].status = 'done';
        db2.jobs[jobId].ocrResults[i] = text;

        // Auto-detect RTL on first successful page
        if (i === 0 && !db2.jobs[jobId].detectedLang) {
          // Heuristic RTL detection from text content
          const rtlChars = (text.match(/[\u0600-\u06FF\u0590-\u05FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
          const totalChars = (text.match(/[^\s\d\p{P}]/gu) || text.replace(/[\s\d]/g, '')).length;
          if (totalChars > 0 && rtlChars / totalChars > 0.3) {
            db2.jobs[jobId].rtl = true;
          }
        }

        const doneCount = db2.jobs[jobId].pages.filter(p => p.status === 'done').length;
        if (doneCount === db2.jobs[jobId].pageCount) {
          db2.jobs[jobId].status = 'done';
        }
        saveDB(db2);

      } catch (err) {
        console.error(`OCR page ${i} error:`, err.message);
        const db2 = loadDB();
        db2.jobs[jobId].pages[i].status = 'failed';
        db2.jobs[jobId].pages[i].error = err.message;

        if (isFatal(err.message)) {
          db2.jobs[jobId].status = 'failed';
          db2.jobs[jobId].fatalError = err.message;
          saveDB(db2);
          break;
        }

        // Check if all pages done/failed
        const allFinished = db2.jobs[jobId].pages.every(p => p.status === 'done' || p.status === 'failed');
        if (allFinished) db2.jobs[jobId].status = 'failed';
        saveDB(db2);
      }
    }
  })();
});

// ── Status polling ────────────────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const db = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });

  const done   = job.pages.filter(p => p.status === 'done').length;
  const failed = job.pages.filter(p => p.status === 'failed').length;
  const total  = job.pageCount;

  res.json({
    status:     job.status,
    progress:   total > 0 ? Math.round(((done + failed) / total) * 100) : 0,
    done,
    failed,
    total,
    fatalError: job.fatalError || null,
    rtl:        job.rtl || false,
    pages:      job.pages.map(p => ({ index: p.index, status: p.status, error: p.error })),
  });
});

// ── Full result ────────────────────────────────────────────────────────────
app.get('/api/result/:jobId', (req, res) => {
  const db = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });

  res.json({
    jobId:        job.id,
    originalName: job.originalName,
    status:       job.status,
    pageCount:    job.pageCount,
    rtl:          job.rtl || false,
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
  const db = loadDB();
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
  const db = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });

  const failedPages = job.pages.filter(p => p.status === 'failed');
  if (failedPages.length === 0) return res.status(400).json({ error: 'No failed pages' });

  // Reset failed pages
  failedPages.forEach(p => { p.status = 'pending'; p.error = null; });
  job.status = 'processing';
  job.fatalError = null;
  if (provider) job.config = { ...job.config, provider, model, ollamaBaseUrl };
  saveDB(db);

  res.json({ jobId: job.id, retrying: failedPages.length });

  const cfg = job.config;
  (async () => {
    for (const page of failedPages) {
      const dbNow = loadDB();
      if (dbNow.jobs[job.id].status === 'cancelled') break;

      dbNow.jobs[job.id].pages[page.index].status = 'processing';
      saveDB(dbNow);

      const prompt = buildOCRPrompt(cfg.language || language, cfg.customPrompt, page.index, job.pageCount);

      try {
        const text = await PROVIDERS[cfg.provider || provider].ocr({
          apiKey: apiKey || cfg.apiKey,
          model:  cfg.model || model,
          imageBase64: job.pages[page.index].imageBase64,
          prompt,
          baseUrl: cfg.ollamaBaseUrl || ollamaBaseUrl,
        });

        const db2 = loadDB();
        db2.jobs[job.id].pages[page.index].status = 'done';
        db2.jobs[job.id].ocrResults[page.index] = text;
        const doneCount = db2.jobs[job.id].pages.filter(p => p.status === 'done').length;
        if (doneCount === db2.jobs[job.id].pageCount) db2.jobs[job.id].status = 'done';
        saveDB(db2);
      } catch (err) {
        const db2 = loadDB();
        db2.jobs[job.id].pages[page.index].status = 'failed';
        db2.jobs[job.id].pages[page.index].error = err.message;
        if (isFatal(err.message)) { db2.jobs[job.id].status = 'failed'; db2.jobs[job.id].fatalError = err.message; saveDB(db2); break; }
        saveDB(db2);
      }
    }
  })();
});

// ── Downloads ─────────────────────────────────────────────────────────────
app.get('/api/download/:jobId/txt', (req, res) => {
  const db = loadDB();
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
    const db = loadDB();
    const job = db.jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: 'Not found' });

    const pages = job.ocrResults.map((t, i) => ({ index: i, text: t || '' }));
    const buffer = await buildDocx(job.originalName, pages);

    const base = path.basename(job.originalName, path.extname(job.originalName));
    res.setHeader('Content-Disposition', `attachment; filename="${base}_ocr.docx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(buffer);
  } catch (err) {
    console.error('DOCX error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Job management ────────────────────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  const db = loadDB();
  const jobs = Object.values(db.jobs)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .map(j => ({
      id:           j.id,
      originalName: j.originalName,
      uploadedAt:   j.uploadedAt,
      status:       j.status,
      pageCount:    j.pageCount,
      provider:     j.config?.provider,
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
  const baseUrl = req.query.baseUrl || 'http://localhost:11434';
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { timeout: 5000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const models = (data.models || []).map(m => ({
      name: m.name,
      size: m.size,
      isVision: /llava|moondream|bakllava|vision|minicpm|qwen.*vl|phi.*vision|cogvlm/i.test(m.name),
    }));
    res.json({ models });
  } catch (err) {
    res.json({ models: [], error: 'Ollama not running or not accessible at ' + baseUrl });
  }
});

// ── Serve UI ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`OCR Desktop server running on http://localhost:${PORT}`));
