const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const router = express.Router();
const { upload } = require('../middleware/upload');
const { enhanceFrameworkControls } = require('../services/gpt');

// ── In-memory job store for async processing ──
// Worker threads run in separate V8 heaps, so if they OOM the main process
// stays alive and the job Map is preserved (job gets marked as 'failed').
const jobs = new Map();

// Clean up old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if ((job.status === 'completed' || job.status === 'failed') && now - job.completedAt > 30 * 60 * 1000) {
      jobs.delete(id);
    } else if (job.status === 'processing' && now - job.startedAt > 15 * 60 * 1000) {
      jobs.set(id, { ...job, status: 'failed', error: 'Processing timed out after 15 minutes', completedAt: Date.now() });
    }
  }
}, 10 * 60 * 1000);

// ── POST /api/framework/parse — Start async processing in worker thread ──
router.post('/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = crypto.randomUUID();
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const mimeType = req.file.mimetype;

    // Store job as processing
    jobs.set(jobId, {
      status: 'processing',
      startedAt: Date.now(),
      fileName,
      progress: 'Parsing file...',
    });

    console.log(`📋 [Job ${jobId}] Started processing: ${fileName}`);

    // Spawn worker thread — runs in its own V8 heap
    const workerPath = path.join(__dirname, '..', 'workers', 'parseFramework.js');
    const worker = new Worker(workerPath, {
      workerData: { filePath, fileName, mimeType, body: req.body || {} },
      // Give the worker up to 3GB of its own heap space
      resourceLimits: {
        maxOldGenerationSizeMb: 4096,
      },
    });

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        const job = jobs.get(jobId);
        if (job) {
          job.progress = msg.progress;
        }
      } else if (msg.type === 'completed') {
        console.log(`✅ [Job ${jobId}] Worker completed successfully`);
        jobs.set(jobId, {
          status: 'completed',
          completedAt: Date.now(),
          result: msg.result,
        });
      } else if (msg.type === 'failed') {
        console.error(`❌ [Job ${jobId}] Worker reported failure: ${msg.error}`);
        jobs.set(jobId, {
          status: 'failed',
          completedAt: Date.now(),
          error: msg.error,
        });
      }
    });

    worker.on('error', (err) => {
      console.error(`❌ [Job ${jobId}] Worker crashed: ${err.message}`);
      jobs.set(jobId, {
        status: 'failed',
        completedAt: Date.now(),
        error: `Processing crashed: ${err.message}. The file may be too large or complex.`,
      });
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`❌ [Job ${jobId}] Worker exited with code ${code}`);
        const job = jobs.get(jobId);
        if (job && job.status === 'processing') {
          jobs.set(jobId, {
            status: 'failed',
            completedAt: Date.now(),
            error: `Processing failed unexpectedly (exit code ${code}). The file may be too large.`,
          });
        }
      }
    });

    // Return immediately with jobId
    return res.json({ jobId, status: 'processing', fileName });
  } catch (err) {
    console.error('❌ Framework parse start error:', err.message);
    res.status(500).json({
      error: 'Failed to start framework file processing',
      details: err.message,
    });
  }
});

// ── GET /api/framework/parse/status/:jobId — Poll for result ──
router.get('/parse/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }

  if (job.status === 'processing') {
    return res.json({
      status: 'processing',
      fileName: job.fileName,
      progress: job.progress || 'Processing...',
      elapsed: Math.round((Date.now() - job.startedAt) / 1000),
    });
  }

  if (job.status === 'completed') {
    return res.json({
      status: 'completed',
      ...job.result,
    });
  }

  if (job.status === 'failed') {
    return res.json({
      status: 'failed',
      error: job.error,
    });
  }
});

// POST /api/framework/enhance — AI-enhance extracted controls
// Fills missing categories, descriptions, infers hierarchy
router.post('/enhance', async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  try {
    const { controls, context } = req.body;

    if (!controls || !Array.isArray(controls) || controls.length === 0) {
      return res.status(400).json({ error: 'controls array is required and must not be empty' });
    }

    if (controls.length > 500) {
      return res.status(400).json({
        error: 'Too many controls for enhancement. Maximum is 500. Consider enhancing in batches.',
      });
    }

    console.log(`\n✨ Enhancing ${controls.length} controls...`);

    let allEnhanced = [];
    let totalSummary = {
      categories_added: 0,
      descriptions_generated: 0,
      hierarchy_inferred: 0,
      numbers_standardized: 0,
    };
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const batchSize = 100;
    const batches = [];
    for (let i = 0; i < controls.length; i += batchSize) {
      batches.push(controls.slice(i, i + batchSize));
    }

    for (let i = 0; i < batches.length; i++) {
      if (batches.length > 1) {
        console.log(`🔄 Enhancing batch ${i + 1}/${batches.length}...`);
      }

      const enhancement = await enhanceFrameworkControls(batches[i], context || {});
      allEnhanced.push(...enhancement.result.controls);

      if (enhancement.result.summary) {
        totalSummary.categories_added += enhancement.result.summary.categories_added || 0;
        totalSummary.descriptions_generated += enhancement.result.summary.descriptions_generated || 0;
        totalSummary.hierarchy_inferred += enhancement.result.summary.hierarchy_inferred || 0;
        totalSummary.numbers_standardized += enhancement.result.summary.numbers_standardized || 0;
      }

      totalUsage.prompt_tokens += enhancement.usage?.prompt_tokens || 0;
      totalUsage.completion_tokens += enhancement.usage?.completion_tokens || 0;
      totalUsage.total_tokens += enhancement.usage?.total_tokens || 0;
    }

    console.log(`✅ Enhancement complete: ${allEnhanced.length} controls enhanced`);

    const normalizedControls = allEnhanced.map((c) => ({
      ...c,
      category: c.group || c.category || null,
    }));

    return res.json({
      success: true,
      data: {
        controls: normalizedControls,
        summary: totalSummary,
        metadata: {
          model: 'gpt-4o',
          tokensUsed: totalUsage,
        },
      },
    });
  } catch (err) {
    console.error('❌ Framework enhance error:', err.message);
    res.status(500).json({
      error: 'Failed to enhance controls',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

module.exports = router;
