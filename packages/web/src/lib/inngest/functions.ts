/**
 * Kairos Inngest Functions
 *
 * Event-driven analysis pipeline:
 *   conversation/ingested → L2 analysis (5 skills) → conversation/analyzed
 *   conversation/analyzed → embeddings → clustering → session detection
 *   Weekly cron → full recluster → coaching insights
 */

import { inngest } from './client';
import { analyzeConversation } from '../kairos-engine/analyze';
import { createServiceClient } from '../supabase/server';

// ============================================================
// L2: Conversation Analysis (triggered on ingestion)
// ============================================================

export const analyzeConversationFn = inngest.createFunction(
  {
    id: 'analyze-conversation',
    retries: 2,
    concurrency: [{ limit: 3 }],
  },
  { event: 'conversation/ingested' },
  async ({ event, step }) => {
    const { conversationId, userId } = event.data;

    // Step 1: Fetch messages
    const messages = await step.run('fetch-messages', async () => {
      const supabase = createServiceClient();
      const { data } = await supabase
        .from('messages')
        .select('role, content, sequence')
        .eq('conversation_id', conversationId)
        .order('sequence');
      return data || [];
    });

    if (messages.length === 0) return { skipped: true, reason: 'no messages' };

    // Step 2: Run L2 analysis pipeline (parallelized skills)
    const result = await step.run('run-analysis', async () => {
      return analyzeConversation({
        id: conversationId,
        userId,
        messages,
      });
    });

    // Step 3: Emit analyzed event for downstream processing
    if (result.success && 'skills' in result) {
      await step.sendEvent('emit-analyzed', {
        name: 'conversation/analyzed',
        data: {
          conversationId,
          userId,
          ideasExtracted: result.skills?.ideas || 0,
          driftScore: null,
        },
      });
    }

    return result;
  }
);

// ============================================================
// Post-Analysis: Embeddings + Clustering + Session Detection
// ============================================================

export const postAnalysisFn = inngest.createFunction(
  {
    id: 'post-analysis',
    retries: 2,
  },
  { event: 'conversation/analyzed' },
  async ({ event, step }) => {
    const { conversationId, userId } = event.data;

    // Step 1: Generate embeddings for new ideas
    const embeddingResult = await step.run('generate-embeddings', async () => {
      try {
        const { generateIdeaEmbeddings } = await import('../kairos-engine/embeddings');
        return await generateIdeaEmbeddings(conversationId, userId);
      } catch (err) {
        console.warn('[Inngest] Embedding generation skipped:', err);
        return { embedded: 0, skipped: 0, error: String(err) };
      }
    });

    // Step 2: Quick-assign ideas to clusters
    const clusterResult = await step.run('quick-cluster', async () => {
      try {
        const { quickAssignClusters } = await import('../kairos-engine/clustering');
        return await quickAssignClusters(conversationId, userId);
      } catch (err) {
        console.warn('[Inngest] Clustering skipped:', err);
        return { assigned: 0, unclustered: 0, error: String(err) };
      }
    });

    // Step 3: Detect sessions
    const sessionResult = await step.run('detect-session', async () => {
      try {
        const { detectAndGroupSession } = await import('../kairos-engine/sessions');
        return await detectAndGroupSession(conversationId, userId);
      } catch (err) {
        console.warn('[Inngest] Session detection skipped:', err);
        return { sessionId: null, isNew: false, error: String(err) };
      }
    });

    // Step 4: Auto-enroll high-importance ideas in SM-2 resurfacing queue
    const resurfaceResult = await step.run('seed-resurfacing', async () => {
      try {
        const { createServiceClient } = await import('../supabase/server');
        const supabase = createServiceClient();

        // Get new ideas from this conversation with importance >= 0.6
        const { data: ideas } = await supabase
          .from('ideas')
          .select('id, importance_score')
          .eq('conversation_id', conversationId)
          .eq('user_id', userId)
          .gte('importance_score', 0.6);

        if (!ideas || ideas.length === 0) return { enrolled: 0 };

        // Enroll each idea (upsert to avoid duplicates)
        const rows = ideas.map((idea: { id: string; importance_score: number }) => ({
          user_id: userId,
          idea_id: idea.id,
          interval_days: 1,
          ease_factor: 2.5,
          next_surface_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Tomorrow
          times_surfaced: 0,
          enrollment_reason: idea.importance_score >= 0.8 ? 'high_importance' : 'cluster_member',
          is_active: true,
        }));

        const { error } = await supabase
          .from('idea_resurfacing')
          .upsert(rows, { onConflict: 'user_id,idea_id' });

        if (error) {
          console.warn('[Inngest] Resurfacing enrollment failed:', error);
          return { enrolled: 0, error: error.message };
        }

        return { enrolled: rows.length };
      } catch (err) {
        console.warn('[Inngest] Resurfacing enrollment skipped:', err);
        return { enrolled: 0, error: String(err) };
      }
    });

    return { embeddingResult, clusterResult, sessionResult, resurfaceResult };
  }
);

// ============================================================
// Weekly: Full Recluster + Coaching Insights
// ============================================================

export const weeklyReclusterFn = inngest.createFunction(
  {
    id: 'weekly-recluster',
    retries: 1,
  },
  { cron: '0 3 * * 1' }, // Monday 3 AM UTC
  async ({ step }) => {
    const supabase = createServiceClient();

    // Get all users with ideas
    const users = await step.run('get-users', async () => {
      const { data } = await supabase
        .from('ideas')
        .select('user_id')
        .not('embedding', 'is', null);

      const uniqueUserIds = [...new Set((data || []).map((r: { user_id: string }) => r.user_id))];
      return uniqueUserIds;
    });

    // Recluster each user
    for (const userId of users) {
      await step.run(`recluster-${userId}`, async () => {
        try {
          const { weeklyRecluster } = await import('../kairos-engine/clustering');
          return await weeklyRecluster(userId);
        } catch (err) {
          console.warn(`[Inngest] Weekly recluster failed for ${userId}:`, err);
          return { error: String(err) };
        }
      });
    }

    return { usersProcessed: users.length };
  }
);
