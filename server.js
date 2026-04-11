const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const fetch   = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const anthropicProvider  = require('./providers/anthropic');
const openaiProvider     = require('./providers/openai');
const geminiProvider     = require('./providers/gemini');
const ollamaProvider     = require('./providers/ollama');
const paddleocrProvider  = require('./providers/paddleocr');
const tesseractProvider  = require('./providers/tesseract');
const imageConverter    = require('./converters/image');
const pdfConverter      = require('./converters/pdf');
const { buildDocx }     = require('./output/docx');

const PORT     = process.env.PORT || 3444;
const DATA_DIR = process.env.APP_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'ocr_jobs.json');

// ── Providers ──────────────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic:  anthropicProvider,
  openai:     openaiProvider,
  gemini:     geminiProvider,
  ollama:     ollamaProvider,
  paddleocr:  paddleocrProvider,
  tesseract:  tesseractProvider,
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
  ollama:     {},  // free / local
  paddleocr:  {},  // free / local
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

const ACTIVE_RUNNERS = new Set();
const PAUSE_POLL_MS = 500;

function getRangeBounds(job, pageFrom = job?.config?.pageFrom, pageTo = job?.config?.pageTo) {
  const lastPage = Math.max(0, (job?.pageCount || 1) - 1);
  const from = Number.isInteger(pageFrom) && pageFrom >= 0 ? Math.min(pageFrom, lastPage) : 0;
  const to = Number.isInteger(pageTo) && pageTo >= 0 ? Math.min(pageTo, lastPage) : lastPage;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

function getSelectedIndices(job, pageFrom = job?.config?.pageFrom, pageTo = job?.config?.pageTo) {
  if (!job || !job.pageCount) return [];
  const { from, to } = getRangeBounds(job, pageFrom, pageTo);
  return Array.from({ length: job.pageCount }, (_, i) => i).filter(i => i >= from && i <= to);
}

function getSelectedCounts(job) {
  const indices = getSelectedIndices(job);
  let done = 0;
  let failed = 0;
  for (const index of indices) {
    const status = job.pages[index]?.status;
    if (status === 'done') done += 1;
    if (status === 'failed') failed += 1;
  }
  return { done, failed, total: indices.length };
}

function selectedPagesAllDone(job) {
  const indices = getSelectedIndices(job);
  return indices.length > 0 && indices.every(i => job.pages[i]?.status === 'done');
}

function selectedPagesAllFinished(job) {
  const indices = getSelectedIndices(job);
  return indices.length > 0 && indices.every(i => ['done', 'failed'].includes(job.pages[i]?.status));
}

async function waitWhilePaused(jobId) {
  while (true) {
    const db = loadDB();
    const job = db.jobs[jobId];
    if (!job || job.status === 'cancelled' || job.fatalError) return false;
    if (job.status !== 'paused') return true;
    await new Promise(resolve => setTimeout(resolve, PAUSE_POLL_MS));
  }
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

// ── Unicode script detector ────────────────────────────────────────────────
// Detects the dominant script from OCR text output.
// Returns { lang, rtl, script }
function detectScriptFromText(text) {
  if (!text || !text.trim()) return null;
  const counts = {
    arabic:     (text.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length,
    hebrew:     (text.match(/[\u0590-\u05FF\uFB1D-\uFB4F]/g) || []).length,
    cjk:        (text.match(/[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\u30A0-\u30FF\u3040-\u309F]/g) || []).length,
    korean:     (text.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g) || []).length,
    cyrillic:   (text.match(/[\u0400-\u04FF]/g) || []).length,
    devanagari: (text.match(/[\u0900-\u097F]/g) || []).length,
    thai:       (text.match(/[\u0E00-\u0E7F]/g) || []).length,
    greek:      (text.match(/[\u0370-\u03FF]/g) || []).length,
    latin:      (text.match(/[A-Za-z]/g) || []).length,
  };
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!dominant || dominant[1] < 5) return null;
  const scriptMap = {
    arabic:     { lang: 'Arabic',   rtl: true  },
    hebrew:     { lang: 'Hebrew',   rtl: true  },
    cjk:        { lang: 'Chinese',  rtl: false },
    korean:     { lang: 'Korean',   rtl: false },
    cyrillic:   { lang: 'Russian',  rtl: false },
    devanagari: { lang: 'Hindi',    rtl: false },
    thai:       { lang: 'Thai',     rtl: false },
    greek:      { lang: 'Greek',    rtl: false },
    latin:      { lang: 'English',  rtl: false },
  };
  return { script: dominant[0], ...scriptMap[dominant[0]] };
}

// Use Tesseract.js (English model) on page 0 to detect script — no Python needed
async function detectScriptFromImage(imageBase64) {
  try {
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker('eng', 1, { logger: () => {}, errorHandler: () => {} });
    const buffer = Buffer.from(imageBase64, 'base64');
    const { data } = await worker.recognize(buffer);
    await worker.terminate();
    return detectScriptFromText(data.text || '');
  } catch {
    return null;
  }
}

// ── OCR mode instructions ──────────────────────────────────────────────────
const OCR_MODE_PROMPTS = {
  book:        'This is a scanned book or article page. Preserve paragraph breaks, chapter titles, and section headings. Maintain the reading flow. Ignore page numbers and running headers.',
  photo:       'This image may be skewed, rotated, low-contrast, or photographed at an angle. Correct for perspective distortion mentally and extract all readable text. If parts are unreadable, mark them [unreadable].',
  structure:   'This is a structured document page. Identify and preserve document roles such as titles, subtitles, body text, headers, footers, and footnotes. Output each recognized block with one label on its own line using ONLY these tags: [TITLE], [SUBTITLE], [BODY], [HEADER], [FOOTER], [FOOTNOTE]. Put the corresponding text on the following line(s). Preserve reading order from top to bottom. Repeat tags as needed. Do not invent missing sections. If a block is uncertain, classify it as [BODY].',
  table:       'This document contains tables. Extract all table data preserving rows and columns. Use | to separate columns and a blank line between rows. Preserve column headers.',
  handwriting: 'This is handwritten text. Do your best to decipher the handwriting accurately. Preserve line breaks. If a word is unclear, write [unclear] instead of guessing.',
  receipt:     'This is a receipt or invoice. Extract: vendor name, date, all line items with quantities and prices, subtotal, tax, and total amount. Format as a clean list.',
  numbers:     'Extract ONLY numbers, amounts, dates, and numeric data. Ignore decorative text and labels unless they provide essential context for the numbers.',
  noheaders:   'Skip page headers, footers, page numbers, running titles, and watermarks. Extract only the main body text.',
};

// ── OCR prompt builder ─────────────────────────────────────────────────────
function buildOCRPrompt(language, customPrompt, pageIndex, pageCount, ocrMode) {
  if (customPrompt) return customPrompt;
  const langHint   = language ? ` The document is written in ${language}.` : ' Auto-detect the language of the text.';
  const pageHint   = pageCount > 1 ? ` This is page ${pageIndex + 1} of ${pageCount}.` : '';
  const modeHint   = (ocrMode && OCR_MODE_PROMPTS[ocrMode]) ? ' ' + OCR_MODE_PROMPTS[ocrMode] : '';
  return `You are a professional OCR (Optical Character Recognition) system.${langHint}${pageHint}${modeHint} Extract ALL text from this image exactly as it appears. Preserve the original layout, visual hierarchy, line breaks, paragraph spacing, indentation, and structural formatting as faithfully as possible. When titles, subtitles, headers, footers, footnotes, or body text are visually distinct, preserve that distinction in the plain-text output. Output ONLY the extracted text — no commentary, no descriptions, no metadata. If the image contains no readable text, output an empty string.`;
}

// ── Language detection prompt ──────────────────────────────────────────────
function buildDetectPrompt() {
  return `Look at this image and identify the primary language of the text. Reply with ONLY a JSON object in this exact format: {"language":"English","rtl":false}. Set rtl to true for Arabic, Hebrew, Persian, Urdu, etc. Use the full English language name.`;
}

async function runOCRJob(jobId, runtimeOptions = {}) {
  if (ACTIVE_RUNNERS.has(jobId)) return;
  ACTIVE_RUNNERS.add(jobId);

  try {
    while (true) {
      const dbCheck = loadDB();
      const job = dbCheck.jobs[jobId];
      if (!job || job.status === 'cancelled' || job.fatalError) break;

      const shouldContinue = await waitWhilePaused(jobId);
      if (!shouldContinue) break;

      const dbCurrent = loadDB();
      const currentJob = dbCurrent.jobs[jobId];
      if (!currentJob || currentJob.status !== 'processing') break;

      const cfg = currentJob.config || {};
      const provider = runtimeOptions.provider || cfg.provider;
      const model = runtimeOptions.model || cfg.model;
      const apiKey = runtimeOptions.apiKey;
      const ollamaBaseUrl = runtimeOptions.ollamaBaseUrl || cfg.ollamaBaseUrl;
      const effectiveLang = runtimeOptions.language || cfg.language || currentJob.detectedLang || null;
      const maxConcurrent = Math.min(
        Math.max(1, parseInt(runtimeOptions.concurrency || cfg.concurrency) || ((provider === 'ollama' || provider === 'paddleocr') ? 1 : 3)),
        (provider === 'ollama' || provider === 'paddleocr') ? 2 : 5
      );

      const pendingIndices = getSelectedIndices(currentJob).filter(i => currentJob.pages[i]?.status === 'pending');

      if (!pendingIndices.length) {
        const dbFinal = loadDB();
        const finalJob = dbFinal.jobs[jobId];
        if (!finalJob) break;

        if (selectedPagesAllDone(finalJob)) {
          finalJob.status = 'done';
        } else if (selectedPagesAllFinished(finalJob)) {
          finalJob.status = 'failed';
        }
        saveDB(dbFinal);
        break;
      }

      const chunk = pendingIndices.slice(0, maxConcurrent);

      const dbMark = loadDB();
      for (const index of chunk) {
        if (dbMark.jobs[jobId].pages[index]?.status === 'pending') {
          dbMark.jobs[jobId].pages[index].status = 'processing';
        }
      }
      saveDB(dbMark);

      await Promise.all(chunk.map(async (index) => {
        const dbNow = loadDB();
        if (dbNow.jobs[jobId]?.status === 'cancelled' || dbNow.jobs[jobId]?.fatalError) return;

        const imageBase64 = dbNow.jobs[jobId].pages[index].imageBase64;
        const prompt = buildOCRPrompt(effectiveLang, cfg.customPrompt, index, currentJob.pageCount, cfg.ocrMode);

        try {
          const text = await PROVIDERS[provider].ocr({
            apiKey,
            model,
            imageBase64,
            prompt,
            baseUrl: ollamaBaseUrl,
            lang: effectiveLang,
          });

          const dbDone = loadDB();
          const page = dbDone.jobs[jobId]?.pages[index];
          if (!page) return;
          page.status = 'done';
          dbDone.jobs[jobId].ocrResults[index] = text;

          if (index === 0 && !dbDone.jobs[jobId].detectedLang && detectRTLFromText(text)) {
            dbDone.jobs[jobId].rtl = true;
          }

          if (selectedPagesAllDone(dbDone.jobs[jobId])) {
            dbDone.jobs[jobId].status = 'done';
          }
          saveDB(dbDone);
        } catch (err) {
          console.error(`OCR page ${index} error:`, err.message);
          const dbFail = loadDB();
          const jobFail = dbFail.jobs[jobId];
          if (!jobFail?.pages[index]) return;

          jobFail.pages[index].status = 'failed';
          jobFail.pages[index].error = err.message;
          jobFail.ocrResults[index] = null;

          if (isFatal(err.message)) {
            jobFail.status = 'failed';
            jobFail.fatalError = err.message;
          } else if (selectedPagesAllFinished(jobFail)) {
            jobFail.status = 'failed';
          }
          saveDB(dbFail);
        }
      }));
    }
  } finally {
    ACTIVE_RUNNERS.delete(jobId);
  }
}

// ── Express setup ──────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ── Upload & convert (async — responds immediately, converts in background) ─
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext       = path.extname(req.file.originalname).toLowerCase();
  const supported = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.webp', '.pdf'];
  if (!supported.includes(ext)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: `Unsupported format: ${ext}` });
  }

  // Create job immediately so client can start polling
  const jobId = uuidv4();
  const db    = loadDB();
  db.jobs[jobId] = {
    id:              jobId,
    originalName:    req.file.originalname,
    uploadedAt:      new Date().toISOString(),
    status:          'converting',   // converting → uploaded (or failed)
    convertProgress: { done: 0, total: 0 },
    pageCount:       0,
    totalBase64Bytes: 0,
    pages:           [],
    ocrResults:      [],
    config:          null,
    fatalError:      null,
    detectedLang:    null,
    rtl:             false,
  };
  saveDB(db);

  // Respond immediately so UI can show progress
  res.json({ jobId, filename: req.file.originalname, status: 'converting' });

  // ── Background conversion ─────────────────────────────────────────────
  (async () => {
    const filePath = req.file.path;
    try {
      const onPage = (done, total) => {
        const db2 = loadDB();
        if (db2.jobs[jobId]) {
          db2.jobs[jobId].convertProgress = { done, total };
          saveDB(db2);
        }
      };

      const pages = ext === '.pdf'
        ? await pdfConverter.toPages(filePath, { onPage })
        : await imageConverter.toPages(filePath, { onPage });

      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      const totalBase64Bytes = pages.reduce((sum, p) => sum + (p.imageBase64 || '').length, 0);

      const db2 = loadDB();
      if (db2.jobs[jobId]) {
        db2.jobs[jobId].status           = 'uploaded';
        db2.jobs[jobId].pageCount        = pages.length;
        db2.jobs[jobId].totalBase64Bytes = totalBase64Bytes;
        db2.jobs[jobId].convertProgress  = { done: pages.length, total: pages.length };
        db2.jobs[jobId].pages            = pages.map(p => ({
          index:       p.index,
          imageBase64: p.imageBase64,
          status:      'pending',
          error:       null,
        }));
        db2.jobs[jobId].ocrResults = new Array(pages.length).fill(null);
        saveDB(db2);
      }

      // ── Auto-detect script from first page (background, non-blocking) ──
      if (pages.length > 0) {
        detectScriptFromImage(pages[0].imageBase64).then(detected => {
          if (detected) {
            const db3 = loadDB();
            if (db3.jobs[jobId]) {
              db3.jobs[jobId].detectedLang    = detected.lang;
              db3.jobs[jobId].rtl             = detected.rtl;
              db3.jobs[jobId].scriptDetected  = true;
              saveDB(db3);
            }
          } else {
            // Could not detect — flag for UI to ask user
            const db3 = loadDB();
            if (db3.jobs[jobId]) {
              db3.jobs[jobId].scriptDetected = false;
              saveDB(db3);
            }
          }
        }).catch(() => {
          const db3 = loadDB();
          if (db3.jobs[jobId]) { db3.jobs[jobId].scriptDetected = false; saveDB(db3); }
        });
      }
    } catch (err) {
      console.error('Conversion error:', err);
      if (fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch {}
      const db2 = loadDB();
      if (db2.jobs[jobId]) {
        db2.jobs[jobId].status     = 'failed';
        db2.jobs[jobId].fatalError = `Conversion failed: ${err.message}`;
        saveDB(db2);
      }
    }
  })();
});

// ── Upload/conversion progress polling ────────────────────────────────────
app.get('/api/upload-status/:jobId', (req, res) => {
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });

  res.json({
    status:            job.status,           // 'converting' | 'uploaded' | 'failed'
    done:              job.convertProgress?.done  || 0,
    total:             job.convertProgress?.total || 0,
    pageCount:         job.pageCount,
    totalBase64Bytes:  job.totalBase64Bytes || 0,
    fatalError:        job.fatalError || null,
    detectedLang:      job.detectedLang      || null,
    rtl:               job.rtl               || false,
    scriptDetected:    job.scriptDetected,   // true=detected, false=unknown, undefined=still running
  });
});

// ── Auto-detect language ───────────────────────────────────────────────────
app.post('/api/detect-language', async (req, res) => {
  const { jobId, provider, model, apiKey, ollamaBaseUrl } = req.body;
  const db  = loadDB();
  const job = db.jobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Invalid provider' });

  // PaddleOCR can't answer language detection prompts — skip
  if (provider === 'paddleocr') {
    return res.json({ language: null, rtl: false, skipped: true });
  }

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

  if (provider === 'ollama' || provider === 'paddleocr') {
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
  const { jobId, provider, model, apiKey, language, ocrMode, customPrompt, ollamaBaseUrl, concurrency, pageFrom, pageTo } = req.body;

  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  if (!provider || !PROVIDERS[provider]) return res.status(400).json({ error: 'Invalid provider' });

  const db  = loadDB();
  const job = db.jobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'converting') return res.status(400).json({ error: 'File is still being split into pages — please wait' });
  if (job.status === 'processing') return res.status(400).json({ error: 'Already processing' });

  // Use detected language if none provided
  const effectiveLang = language || job.detectedLang || null;

  // Concurrency: how many pages to process in parallel
  // Ollama = 1 (single local GPU), cloud APIs = up to 5
  const isLocal = provider === 'ollama' || provider === 'paddleocr';
  const maxConcurrent = Math.min(
    Math.max(1, parseInt(concurrency) || (isLocal ? 1 : 3)),
    isLocal ? 2 : 5
  );

  const { from: rangeFrom, to: rangeTo } = getRangeBounds(job, pageFrom, pageTo);
  const targetIndices = getSelectedIndices(job, rangeFrom, rangeTo);

  for (const index of targetIndices) {
    job.pages[index].status = 'pending';
    job.pages[index].error = null;
    job.ocrResults[index] = null;
  }
  job.status = 'processing';
  job.config = { provider, model, language: effectiveLang, ocrMode: ocrMode || 'standard', customPrompt, ollamaBaseUrl, concurrency: maxConcurrent, pageFrom: rangeFrom, pageTo: rangeTo };
  saveDB(db);

  res.json({ jobId, pageCount: job.pageCount, selectedCount: targetIndices.length, concurrency: maxConcurrent });
  runOCRJob(jobId, {
    provider,
    model,
    apiKey,
    language: effectiveLang,
    ollamaBaseUrl,
    concurrency: maxConcurrent,
  });
});

// ── Status polling ────────────────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });

  const { done, failed, total } = getSelectedCounts(job);

  res.json({
    status:       job.status,
    progress:     total > 0 ? Math.round(((done + failed) / total) * 100) : 0,
    done,
    failed,
    total,
    pageCount:    job.pageCount,
    pageFrom:     job.config?.pageFrom ?? 0,
    pageTo:       job.config?.pageTo ?? Math.max(0, job.pageCount - 1),
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
  if (!['processing', 'paused'].includes(job.status)) return res.status(400).json({ error: 'Not processing' });
  db.jobs[req.params.jobId].status = 'cancelled';
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/pause/:jobId', (req, res) => {
  const db = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'processing') return res.status(400).json({ error: 'Job is not running' });
  job.status = 'paused';
  saveDB(db);
  res.json({ ok: true, status: 'paused' });
});

app.post('/api/resume/:jobId', (req, res) => {
  const { provider, model, apiKey, language, ocrMode, customPrompt, ollamaBaseUrl, concurrency } = req.body || {};
  const db = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'paused') return res.status(400).json({ error: 'Job is not paused' });

  const cfg = job.config || {};
  job.status = 'processing';
  job.config = {
    ...cfg,
    provider: provider || cfg.provider,
    model: model || cfg.model,
    language: language || cfg.language,
    ocrMode: ocrMode || cfg.ocrMode || 'standard',
    customPrompt: customPrompt ?? cfg.customPrompt,
    ollamaBaseUrl: ollamaBaseUrl || cfg.ollamaBaseUrl,
    concurrency: concurrency ? Math.max(1, parseInt(concurrency) || cfg.concurrency || 1) : cfg.concurrency,
  };

  if (!ACTIVE_RUNNERS.has(job.id)) {
    for (const index of getSelectedIndices(job)) {
      if (job.pages[index]?.status === 'processing') {
        job.pages[index].status = 'pending';
      }
    }
  }
  saveDB(db);

  runOCRJob(job.id, {
    provider: job.config.provider,
    model: job.config.model,
    apiKey,
    language: job.config.language,
    ocrMode: job.config.ocrMode,
    customPrompt: job.config.customPrompt,
    ollamaBaseUrl: job.config.ollamaBaseUrl,
    concurrency: job.config.concurrency,
  });

  res.json({ ok: true, status: 'processing' });
});

// ── Retry failed pages ─────────────────────────────────────────────────────
app.post('/api/retry/:jobId', async (req, res) => {
  const {
    provider,
    model,
    apiKey,
    language,
    ocrMode,
    customPrompt,
    ollamaBaseUrl,
    concurrency,
    pageFrom,
    pageTo,
    failedOnly = true,
  } = req.body || {};
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });

  const cfg = job.config || {};
  const retryProvider = provider || cfg.provider;
  if (!retryProvider || !PROVIDERS[retryProvider]) return res.status(400).json({ error: 'Invalid provider' });

  const { from: retryFrom, to: retryTo } = getRangeBounds(job, pageFrom, pageTo);
  const candidateIndices = getSelectedIndices(job, retryFrom, retryTo);
  const retryIndices = failedOnly
    ? candidateIndices.filter(i => job.pages[i]?.status === 'failed')
    : candidateIndices;

  if (!retryIndices.length) {
    return res.status(400).json({ error: failedOnly ? 'No failed pages in that range' : 'No pages selected' });
  }

  retryIndices.forEach(index => {
    job.pages[index].status = 'pending';
    job.pages[index].error = null;
    job.ocrResults[index] = null;
  });
  job.status = 'processing';
  job.fatalError = null;
  job.config = {
    ...cfg,
    provider: retryProvider,
    model: model || cfg.model,
    language: language || cfg.language || job.detectedLang || null,
    ocrMode: ocrMode || cfg.ocrMode || 'standard',
    customPrompt: customPrompt ?? cfg.customPrompt,
    ollamaBaseUrl: ollamaBaseUrl || cfg.ollamaBaseUrl,
    concurrency: concurrency ? Math.max(1, parseInt(concurrency) || cfg.concurrency || 1) : cfg.concurrency,
    pageFrom: retryFrom,
    pageTo: retryTo,
  };
  saveDB(db);

  res.json({ jobId: job.id, retrying: retryIndices.length, failedOnly, pageFrom: retryFrom, pageTo: retryTo });
  runOCRJob(job.id, {
    provider: job.config.provider,
    model: job.config.model,
    apiKey,
    language: job.config.language,
    ocrMode: job.config.ocrMode,
    customPrompt: job.config.customPrompt,
    ollamaBaseUrl: job.config.ollamaBaseUrl,
    concurrency: job.config.concurrency,
  });
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
    const buffer = await buildDocx(job.originalName, pages, { rtl: job.rtl || false });
    const base   = path.basename(job.originalName, path.extname(job.originalName));
    res.setHeader('Content-Disposition', `attachment; filename="${base}_ocr.docx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Single page image (for preview pane) ─────────────────────────────────
app.get('/api/page-image/:jobId/:pageIndex', (req, res) => {
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });
  const idx  = parseInt(req.params.pageIndex);
  const page = (job.pages || []).find(p => p.index === idx);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  // Return as actual PNG image so browser can cache it efficiently
  const buf = Buffer.from(page.imageBase64 || '', 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(buf);
});

// ── Page images list (thumbnails — returns URLs only, no base64) ──────────
app.get('/api/page-images/:jobId', (req, res) => {
  const db  = loadDB();
  const job = db.jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });
  const pages = (job.pages || []).map(p => ({
    index: p.index,
    url:   `/api/page-image/${req.params.jobId}/${p.index}`,
  }));
  res.json({ pages });
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
