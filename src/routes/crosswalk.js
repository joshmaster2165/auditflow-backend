const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { supabase } = require('../utils/supabase');
const { createJobStore } = require('../utils/analysisHelpers');
const { runCrosswalkGeneration } = require('../services/crosswalkGenerator');

// ── In-memory job store for async crosswalk generation ──
const jobs = createJobStore({ processingTimeoutMs: 20 * 60 * 1000 });

// ──────────────────────────────────────────────────────────────────────
// POST /api/crosswalk/generate — Trigger async crosswalk generation
// ──────────────────────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  try {
    const { framework_a_id, framework_b_id, name } = req.body;

    // Validate required fields
    if (!framework_a_id || !framework_b_id) {
      return res.status(400).json({ error: 'Both framework_a_id and framework_b_id are required.' });
    }

    if (framework_a_id === framework_b_id) {
      return res.status(400).json({ error: 'Cannot create a crosswalk between a framework and itself.' });
    }

    // Validate both frameworks exist
    const { data: frameworkA, error: errA } = await supabase
      .from('frameworks')
      .select('id, name')
      .eq('id', framework_a_id)
      .single();

    const { data: frameworkB, error: errB } = await supabase
      .from('frameworks')
      .select('id, name')
      .eq('id', framework_b_id)
      .single();

    if (errA || !frameworkA) {
      return res.status(404).json({ error: `Framework A not found: ${framework_a_id}` });
    }
    if (errB || !frameworkB) {
      return res.status(404).json({ error: `Framework B not found: ${framework_b_id}` });
    }

    // Check for existing crosswalk for this pair (bidirectional check)
    const minId = framework_a_id < framework_b_id ? framework_a_id : framework_b_id;
    const maxId = framework_a_id < framework_b_id ? framework_b_id : framework_a_id;

    const { data: existing, error: existErr } = await supabase
      .from('crosswalks')
      .select('id, status')
      .or(`and(framework_a_id.eq.${minId},framework_b_id.eq.${maxId}),and(framework_a_id.eq.${maxId},framework_b_id.eq.${minId})`);

    if (!existErr && existing && existing.length > 0) {
      const active = existing.find(c => c.status === 'completed' || c.status === 'processing');
      if (active) {
        return res.status(409).json({
          error: `A crosswalk already exists for this framework pair (status: ${active.status}).`,
          crosswalkId: active.id,
        });
      }
      // If only failed ones exist, delete them so we can regenerate
      for (const old of existing) {
        await supabase.from('crosswalk_mappings').delete().eq('crosswalk_id', old.id);
        await supabase.from('crosswalks').delete().eq('id', old.id);
      }
    }

    // Get control counts for the response
    const { count: countA } = await supabase
      .from('controls')
      .select('id', { count: 'exact', head: true })
      .eq('framework_id', framework_a_id);

    const { count: countB } = await supabase
      .from('controls')
      .select('id', { count: 'exact', head: true })
      .eq('framework_id', framework_b_id);

    // Create the crosswalk row
    const crosswalkName = name || `${frameworkA.name} vs ${frameworkB.name}`;

    const { data: crosswalk, error: insertErr } = await supabase
      .from('crosswalks')
      .insert({
        framework_a_id,
        framework_b_id,
        name: crosswalkName,
        status: 'processing',
      })
      .select()
      .single();

    if (insertErr) {
      console.error('Failed to create crosswalk row:', insertErr.message);
      return res.status(500).json({ error: 'Failed to create crosswalk record.', details: insertErr.message });
    }

    // Create in-memory job entry
    const jobId = crypto.randomUUID();
    jobs.set(jobId, {
      status: 'processing',
      startedAt: Date.now(),
      progress: 'Initializing crosswalk generation...',
      batchesTotal: 0,
      batchesCompleted: 0,
      mappingsFound: 0,
    });

    console.log(`\ud83d\uddd3\ufe0f [Crosswalk] Starting generation: ${crosswalkName} (${crosswalk.id}), job: ${jobId}`);

    // Fire-and-forget the async generation
    runCrosswalkGeneration(crosswalk.id, jobId, jobs).catch(err => {
      console.error(`\u274c [Crosswalk] Unhandled error in generation:`, err.message);
    });

    // Return immediately
    return res.status(202).json({
      success: true,
      crosswalkId: crosswalk.id,
      jobId,
      status: 'processing',
      name: crosswalkName,
      frameworks: {
        a: { id: frameworkA.id, name: frameworkA.name },
        b: { id: frameworkB.id, name: frameworkB.name },
      },
      controlCounts: { a: countA || 0, b: countB || 0 },
    });
  } catch (err) {
    console.error('\u274c Crosswalk generate error:', err.message);
    res.status(500).json({ error: 'Failed to start crosswalk generation.', details: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/crosswalk/generate/status/:jobId — Poll generation progress
// ──────────────────────────────────────────────────────────────────────
router.get('/generate/status/:jobId', (req, res) => {
  // Prevent browser caching so polling always gets fresh data
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');

  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired.' });
  }

  if (job.status === 'processing') {
    return res.json({
      status: 'processing',
      progress: job.progress || 'Processing...',
      batchesCompleted: job.batchesCompleted || 0,
      batchesTotal: job.batchesTotal || 0,
      mappingsFound: job.mappingsFound || 0,
      elapsed: Math.round((Date.now() - job.startedAt) / 1000),
    });
  }

  if (job.status === 'completed') {
    return res.json({
      status: 'completed',
      crosswalkId: job.crosswalkId,
      totalMappings: job.totalMappings,
      avgConfidence: job.avgConfidence,
      metadata: job.metadata || {},
    });
  }

  if (job.status === 'failed') {
    return res.json({
      status: 'failed',
      error: job.error,
    });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/crosswalk — List all crosswalks
// ──────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('crosswalks')
      .select(`
        *,
        framework_a:framework_a_id (id, name),
        framework_b:framework_b_id (id, name)
      `)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch crosswalks.', details: error.message });
    }

    return res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('\u274c List crosswalks error:', err.message);
    res.status(500).json({ error: 'Failed to list crosswalks.', details: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/crosswalk/by-framework/:frameworkId — List crosswalks for a framework
// ──────────────────────────────────────────────────────────────────────
router.get('/by-framework/:frameworkId', async (req, res) => {
  try {
    const { frameworkId } = req.params;

    const { data, error } = await supabase
      .from('crosswalks')
      .select(`
        *,
        framework_a:framework_a_id (id, name),
        framework_b:framework_b_id (id, name)
      `)
      .or(`framework_a_id.eq.${frameworkId},framework_b_id.eq.${frameworkId}`)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch crosswalks.', details: error.message });
    }

    return res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('\u274c By-framework crosswalks error:', err.message);
    res.status(500).json({ error: 'Failed to fetch crosswalks.', details: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/crosswalk/:crosswalkId — Fetch crosswalk with all mappings
// Supports: ?perspective=<frameworkId>, ?min_confidence=0.5, ?status=ai_generated,user_verified
// ──────────────────────────────────────────────────────────────────────
router.get('/:crosswalkId', async (req, res) => {
  try {
    const { crosswalkId } = req.params;
    const { perspective, min_confidence, status: statusFilter } = req.query;

    // Fetch the crosswalk
    const { data: crosswalk, error: cwErr } = await supabase
      .from('crosswalks')
      .select(`
        *,
        framework_a:framework_a_id (id, name),
        framework_b:framework_b_id (id, name)
      `)
      .eq('id', crosswalkId)
      .single();

    if (cwErr || !crosswalk) {
      return res.status(404).json({ error: 'Crosswalk not found.' });
    }

    // Build the mappings query
    let mappingsQuery = supabase
      .from('crosswalk_mappings')
      .select(`
        *,
        control_a:control_a_id (id, control_number, title, description, category),
        control_b:control_b_id (id, control_number, title, description, category)
      `)
      .eq('crosswalk_id', crosswalkId);

    // Filter by status (default: exclude user_removed)
    if (statusFilter) {
      const statuses = statusFilter.split(',').map(s => s.trim());
      mappingsQuery = mappingsQuery.in('status', statuses);
    } else {
      mappingsQuery = mappingsQuery.neq('status', 'user_removed');
    }

    // Filter by minimum confidence
    if (min_confidence) {
      const minConf = parseFloat(min_confidence);
      if (!isNaN(minConf)) {
        // Filter on ai_confidence (manual_confidence is handled at app layer)
        mappingsQuery = mappingsQuery.gte('ai_confidence', minConf);
      }
    }

    mappingsQuery = mappingsQuery.order('ai_confidence', { ascending: false });

    const { data: mappings, error: mapErr } = await mappingsQuery;

    if (mapErr) {
      return res.status(500).json({ error: 'Failed to fetch mappings.', details: mapErr.message });
    }

    // Add effective_confidence field and optionally swap perspective
    const isFlipped = perspective && perspective === crosswalk.framework_b_id;

    const enrichedMappings = (mappings || []).map(m => {
      const effectiveConfidence = m.manual_confidence != null ? m.manual_confidence : m.ai_confidence;

      if (isFlipped) {
        // Swap control_a and control_b for the flipped perspective
        return {
          ...m,
          control_a: m.control_b,
          control_b: m.control_a,
          effective_confidence: effectiveConfidence,
        };
      }

      return {
        ...m,
        effective_confidence: effectiveConfidence,
      };
    });

    // Compute statistics
    const activeMappings = (mappings || []).filter(m => m.status !== 'user_removed');
    const stats = {
      total: activeMappings.length,
      by_relationship: {
        equivalent: activeMappings.filter(m => m.relationship_type === 'equivalent').length,
        partial_overlap: activeMappings.filter(m => m.relationship_type === 'partial_overlap').length,
        related: activeMappings.filter(m => m.relationship_type === 'related').length,
        subset: activeMappings.filter(m => m.relationship_type === 'subset').length,
        superset: activeMappings.filter(m => m.relationship_type === 'superset').length,
      },
      by_status: {
        ai_generated: activeMappings.filter(m => m.status === 'ai_generated').length,
        user_verified: activeMappings.filter(m => m.status === 'user_verified').length,
        user_added: activeMappings.filter(m => m.status === 'user_added').length,
      },
      avg_confidence: activeMappings.length > 0
        ? parseFloat((activeMappings.reduce((s, m) => s + parseFloat(m.ai_confidence), 0) / activeMappings.length).toFixed(2))
        : 0,
    };

    return res.json({
      success: true,
      data: {
        crosswalk: {
          ...crosswalk,
          // If flipped, swap framework labels for the client
          ...(isFlipped && {
            framework_a: crosswalk.framework_b,
            framework_b: crosswalk.framework_a,
          }),
        },
        mappings: enrichedMappings,
        statistics: stats,
      },
    });
  } catch (err) {
    console.error('\u274c Fetch crosswalk error:', err.message);
    res.status(500).json({ error: 'Failed to fetch crosswalk.', details: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/crosswalk/:crosswalkId/mappings — Add a manual mapping
// ──────────────────────────────────────────────────────────────────────
router.post('/:crosswalkId/mappings', async (req, res) => {
  try {
    const { crosswalkId } = req.params;
    const { control_a_id, control_b_id, relationship_type, manual_confidence, user_notes } = req.body;

    if (!control_a_id || !control_b_id) {
      return res.status(400).json({ error: 'Both control_a_id and control_b_id are required.' });
    }

    // Validate the crosswalk exists
    const { data: crosswalk, error: cwErr } = await supabase
      .from('crosswalks')
      .select('id, framework_a_id, framework_b_id')
      .eq('id', crosswalkId)
      .single();

    if (cwErr || !crosswalk) {
      return res.status(404).json({ error: 'Crosswalk not found.' });
    }

    // Validate controls belong to the correct frameworks
    const { data: controlA } = await supabase
      .from('controls')
      .select('id, framework_id')
      .eq('id', control_a_id)
      .single();

    const { data: controlB } = await supabase
      .from('controls')
      .select('id, framework_id')
      .eq('id', control_b_id)
      .single();

    if (!controlA || controlA.framework_id !== crosswalk.framework_a_id) {
      return res.status(400).json({ error: 'control_a_id must belong to framework A of this crosswalk.' });
    }
    if (!controlB || controlB.framework_id !== crosswalk.framework_b_id) {
      return res.status(400).json({ error: 'control_b_id must belong to framework B of this crosswalk.' });
    }

    // Check for existing mapping (might be a soft-deleted one we can restore)
    const { data: existing } = await supabase
      .from('crosswalk_mappings')
      .select('id, status')
      .eq('crosswalk_id', crosswalkId)
      .eq('control_a_id', control_a_id)
      .eq('control_b_id', control_b_id)
      .single();

    let mapping;

    if (existing && existing.status === 'user_removed') {
      // Restore the soft-deleted mapping
      const { data: restored, error: restoreErr } = await supabase
        .from('crosswalk_mappings')
        .update({
          status: 'user_added',
          relationship_type: relationship_type || 'related',
          manual_confidence: manual_confidence != null ? manual_confidence : null,
          user_notes: user_notes || null,
          ai_confidence: existing.ai_confidence || 0,
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (restoreErr) {
        return res.status(500).json({ error: 'Failed to restore mapping.', details: restoreErr.message });
      }
      mapping = restored;
    } else if (existing) {
      return res.status(409).json({ error: 'A mapping already exists for this control pair.', mappingId: existing.id });
    } else {
      // Create new mapping
      const { data: created, error: createErr } = await supabase
        .from('crosswalk_mappings')
        .insert({
          crosswalk_id: crosswalkId,
          control_a_id,
          control_b_id,
          ai_confidence: 0,
          relationship_type: relationship_type || 'related',
          ai_rationale: null,
          manual_confidence: manual_confidence != null ? manual_confidence : null,
          user_notes: user_notes || null,
          status: 'user_added',
        })
        .select()
        .single();

      if (createErr) {
        return res.status(500).json({ error: 'Failed to create mapping.', details: createErr.message });
      }
      mapping = created;
    }

    // Update crosswalk statistics
    await updateCrosswalkStats(crosswalkId);

    return res.status(201).json({ success: true, data: mapping });
  } catch (err) {
    console.error('\u274c Add mapping error:', err.message);
    res.status(500).json({ error: 'Failed to add mapping.', details: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/crosswalk/:crosswalkId/mappings/:mappingId — Edit a mapping
// ──────────────────────────────────────────────────────────────────────
router.patch('/:crosswalkId/mappings/:mappingId', async (req, res) => {
  try {
    const { crosswalkId, mappingId } = req.params;
    const { manual_confidence, relationship_type, user_notes, status, verified_by } = req.body;

    // Build update object with only provided fields
    const updates = {};

    if (manual_confidence !== undefined) {
      const mc = parseFloat(manual_confidence);
      if (isNaN(mc) || mc < 0 || mc > 1) {
        return res.status(400).json({ error: 'manual_confidence must be between 0.0 and 1.0.' });
      }
      updates.manual_confidence = mc;
    }

    if (relationship_type !== undefined) {
      const valid = ['equivalent', 'partial_overlap', 'related', 'subset', 'superset'];
      if (!valid.includes(relationship_type)) {
        return res.status(400).json({ error: `relationship_type must be one of: ${valid.join(', ')}` });
      }
      updates.relationship_type = relationship_type;
    }

    if (user_notes !== undefined) {
      updates.user_notes = user_notes;
    }

    if (status !== undefined) {
      const validStatuses = ['ai_generated', 'user_verified', 'user_added', 'user_removed'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
      }
      updates.status = status;

      // Auto-set verified_at when marking as verified
      if (status === 'user_verified') {
        updates.verified_at = new Date().toISOString();
        if (verified_by) updates.verified_by = verified_by;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid update fields provided.' });
    }

    // Perform the update
    const { data: updated, error: updateErr } = await supabase
      .from('crosswalk_mappings')
      .update(updates)
      .eq('id', mappingId)
      .eq('crosswalk_id', crosswalkId)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ error: 'Failed to update mapping.', details: updateErr.message });
    }

    if (!updated) {
      return res.status(404).json({ error: 'Mapping not found in this crosswalk.' });
    }

    // Update crosswalk statistics
    await updateCrosswalkStats(crosswalkId);

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('\u274c Edit mapping error:', err.message);
    res.status(500).json({ error: 'Failed to update mapping.', details: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/crosswalk/:crosswalkId — Delete entire crosswalk
// ──────────────────────────────────────────────────────────────────────
router.delete('/:crosswalkId', async (req, res) => {
  try {
    const { crosswalkId } = req.params;

    // Get the crosswalk to confirm it exists and report mapping count
    const { data: crosswalk, error: cwErr } = await supabase
      .from('crosswalks')
      .select('id, total_mappings')
      .eq('id', crosswalkId)
      .single();

    if (cwErr || !crosswalk) {
      return res.status(404).json({ error: 'Crosswalk not found.' });
    }

    // Delete (CASCADE handles crosswalk_mappings)
    const { error: deleteErr } = await supabase
      .from('crosswalks')
      .delete()
      .eq('id', crosswalkId);

    if (deleteErr) {
      return res.status(500).json({ error: 'Failed to delete crosswalk.', details: deleteErr.message });
    }

    return res.json({
      success: true,
      message: `Crosswalk and all ${crosswalk.total_mappings || 0} mappings deleted.`,
    });
  } catch (err) {
    console.error('\u274c Delete crosswalk error:', err.message);
    res.status(500).json({ error: 'Failed to delete crosswalk.', details: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Helper: Recalculate crosswalk statistics after mapping edits
// ──────────────────────────────────────────────────────────────────────
async function updateCrosswalkStats(crosswalkId) {
  try {
    const { data: activeMappings, error } = await supabase
      .from('crosswalk_mappings')
      .select('ai_confidence')
      .eq('crosswalk_id', crosswalkId)
      .neq('status', 'user_removed');

    if (error || !activeMappings) return;

    const totalMappings = activeMappings.length;
    const avgConfidence = totalMappings > 0
      ? parseFloat((activeMappings.reduce((s, m) => s + parseFloat(m.ai_confidence), 0) / totalMappings).toFixed(2))
      : 0;

    await supabase
      .from('crosswalks')
      .update({ total_mappings: totalMappings, avg_confidence: avgConfidence })
      .eq('id', crosswalkId);
  } catch (err) {
    console.error('  Failed to update crosswalk stats:', err.message);
  }
}

module.exports = router;
