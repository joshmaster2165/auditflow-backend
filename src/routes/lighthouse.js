const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../utils/supabase');
const {
  getOrCreateVectorStore,
  uploadEvidenceToVectorStore,
  getProjectControlIds,
  streamChat,
} = require('../services/lighthouseAgent');

// Reuse the existing custom instructions fetcher
async function fetchCustomInstructions(projectId) {
  if (!projectId) return null;
  try {
    const { data } = await supabaseAdmin
      .from('projects')
      .select('custom_instructions')
      .eq('id', projectId)
      .single();
    return data?.custom_instructions || null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────
// POST /api/lighthouse/:projectId/chat
// Send a message to Lighthouse, receive SSE stream
// ──────────────────────────────────────────────────────
router.post('/:projectId/chat', async (req, res) => {
  const { projectId } = req.params;
  const { message, threadId } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx/Railway proxy buffering
  });

  try {
    // 1. Get or create vector store for the project
    let vectorStoreId = null;
    try {
      vectorStoreId = await getOrCreateVectorStore(projectId);
    } catch (err) {
      console.warn(`⚠️ Could not get vector store: ${err.message}`);
      // Continue without file search — function tools still work
    }

    // 2. Get custom instructions
    const customInstructions = await fetchCustomInstructions(projectId);

    // 3. If threadId provided, fetch the last response ID
    let lastResponseId = null;

    if (threadId) {
      const { data } = await supabaseAdmin
        .from('lighthouse_threads')
        .select('openai_response_id')
        .eq('id', threadId)
        .eq('project_id', projectId)
        .single();

      if (data) {
        lastResponseId = data.openai_response_id;
      }
    }

    // 4. Stream the response
    console.log(`🔦 Lighthouse chat: project=${projectId}, thread=${threadId || 'new'}, message="${message.substring(0, 80)}..."`);

    const finalResponse = await streamChat({
      projectId,
      message: message.trim(),
      lastResponseId,
      customInstructions,
      vectorStoreId,
      res,
    });

    if (!finalResponse) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'No response generated' })}\n\n`);
      res.end();
      return;
    }

    // 5. After streaming completes, update or create the thread record
    const responseId = finalResponse.id;

    if (threadId) {
      // Update existing thread
      await supabaseAdmin
        .from('lighthouse_threads')
        .update({
          openai_response_id: responseId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', threadId);

      res.write(`data: ${JSON.stringify({ type: 'done', threadId, responseId })}\n\n`);
    } else {
      // Create new thread — use first ~60 chars of message as title
      const title = message.trim().substring(0, 60) + (message.length > 60 ? '...' : '');

      const { data: newThread } = await supabaseAdmin
        .from('lighthouse_threads')
        .insert({
          project_id: projectId,
          openai_response_id: responseId,
          title,
        })
        .select('id')
        .single();

      res.write(`data: ${JSON.stringify({ type: 'done', threadId: newThread?.id || null, responseId })}\n\n`);
    }

    res.end();
  } catch (err) {
    console.error('❌ Lighthouse chat error:', err.message);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    } catch (_) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Lighthouse chat failed', details: err.message });
      }
    }
  }
});

// ──────────────────────────────────────────────────────
// GET /api/lighthouse/:projectId/threads
// List conversation threads for a project
// ──────────────────────────────────────────────────────
router.get('/:projectId/threads', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('lighthouse_threads')
      .select('id, title, created_at, updated_at')
      .eq('project_id', req.params.projectId)
      .order('updated_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch threads', details: error.message });
    }

    res.json({ success: true, threads: data || [] });
  } catch (err) {
    console.error('❌ List threads error:', err.message);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// ──────────────────────────────────────────────────────
// GET /api/lighthouse/:projectId/threads/:threadId/messages
// Get message history for a conversation
// ──────────────────────────────────────────────────────
router.get('/:projectId/threads/:threadId/messages', async (req, res) => {
  try {
    const { threadId, projectId } = req.params;
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 1. Fetch the thread to get the last response ID
    const { data: thread } = await supabaseAdmin
      .from('lighthouse_threads')
      .select('openai_response_id')
      .eq('id', threadId)
      .eq('project_id', projectId)
      .single();

    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    // 2. Retrieve the response to get conversation history
    const messages = [];

    try {
      // Fetch input items (the full conversation leading up to the last response)
      const inputItems = await openai.responses.inputItems.list(thread.openai_response_id);

      for await (const item of inputItems) {
        if (item.type === 'message') {
          messages.push({
            role: item.role,
            content: typeof item.content === 'string'
              ? item.content
              : (item.content || []).map(c => c.text || '').join(''),
          });
        }
      }

      // Fetch the last response itself for the assistant's reply
      const response = await openai.responses.retrieve(thread.openai_response_id);
      for (const outputItem of (response.output || [])) {
        if (outputItem.type === 'message') {
          const text = (outputItem.content || []).map(c => c.text || '').join('');
          if (text) {
            messages.push({ role: 'assistant', content: text });
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ Could not fetch OpenAI response chain: ${err.message}`);
      // Return whatever we have — the thread exists but the response chain may have expired
    }

    res.json({ success: true, messages });
  } catch (err) {
    console.error('❌ Get messages error:', err.message);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ──────────────────────────────────────────────────────
// DELETE /api/lighthouse/:projectId/threads/:threadId
// Delete a conversation
// ──────────────────────────────────────────────────────
router.delete('/:projectId/threads/:threadId', async (req, res) => {
  try {
    const { threadId, projectId } = req.params;

    const { error } = await supabaseAdmin
      .from('lighthouse_threads')
      .delete()
      .eq('id', threadId)
      .eq('project_id', projectId);

    if (error) {
      return res.status(500).json({ error: 'Failed to delete thread', details: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete thread error:', err.message);
    res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// ──────────────────────────────────────────────────────
// POST /api/lighthouse/:projectId/sync
// Back-fill vector store with existing evidence
// ──────────────────────────────────────────────────────
router.post('/:projectId/sync', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Fetch all evidence without an openai_file_id — direct project_id first
    let { data: unsyncedEvidence, error } = await supabaseAdmin
      .from('evidence')
      .select('*')
      .eq('project_id', projectId)
      .is('openai_file_id', null);

    // Fallback: query through project → framework → controls chain
    if (!unsyncedEvidence || unsyncedEvidence.length === 0) {
      console.log(`📚 Sync: direct project_id query returned 0 — trying control-based fallback`);
      const controlIds = await getProjectControlIds(projectId);
      if (controlIds.length > 0) {
        ({ data: unsyncedEvidence, error } = await supabaseAdmin
          .from('evidence')
          .select('*')
          .in('control_id', controlIds)
          .is('openai_file_id', null));
      }
    }

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch evidence', details: error.message });
    }

    if (!unsyncedEvidence || unsyncedEvidence.length === 0) {
      return res.json({ success: true, synced: 0, total: 0, message: 'All evidence already synced' });
    }

    console.log(`📚 Syncing ${unsyncedEvidence.length} evidence files to vector store for project ${projectId}`);

    // Upload in parallel batches of 3
    const CONCURRENCY = 3;
    let synced = 0;
    const errors = [];

    for (let i = 0; i < unsyncedEvidence.length; i += CONCURRENCY) {
      const batch = unsyncedEvidence.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(ev => uploadEvidenceToVectorStore(ev))
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          synced++;
        } else if (r.status === 'rejected') {
          errors.push(r.reason?.message || 'Unknown error');
        }
      }
    }

    console.log(`📚 Sync complete: ${synced}/${unsyncedEvidence.length} files synced`);

    res.json({
      success: true,
      synced,
      total: unsyncedEvidence.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('❌ Sync error:', err.message);
    res.status(500).json({ error: 'Sync failed', details: err.message });
  }
});

module.exports = router;
