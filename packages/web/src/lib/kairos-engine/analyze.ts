/**
 * Kairos Engine — The Gateway's Analysis Orchestrator
 *
 * This is the "Attention Engine" from the architecture doc.
 * It takes a raw conversation, runs it through the skill pipeline,
 * and stores the structured results.
 *
 * Pipeline:
 * 1. idea-extractor → Extract discrete ideas
 * 2. intent-classifier → Determine original intent
 * 3. drift-analyzer → Measure topic drift
 * 4. action-item-extractor → Find commitments
 * 5. revisit-moment-detector → Surface moments worth revisiting
 * 6. prompt-efficiency-analyzer → Evaluate prompting effectiveness + extract lessons
 * 7. Embedding generation → For similarity search
 * 8. Clustering → Group ideas across conversations
 *
 * Audit Trail:
 * Every skill execution is logged to the audit_log table,
 * recording: skill name, action, conversation, data type,
 * destination (local/cloud), duration, and item counts.
 * This implements the AgentVault-inspired trust pattern.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  IDEA_EXTRACTOR_PROMPT,
  INTENT_CLASSIFIER_PROMPT,
  DRIFT_ANALYZER_PROMPT,
  ACTION_ITEM_PROMPT,
  REVISIT_MOMENT_PROMPT,
  PROMPT_EFFICIENCY_PROMPT,
  formatConversationForPrompt,
  formatFirstMessages,
  formatIdeasForContext,
} from '../prompts/skills';
import { createServiceClient } from '../supabase/server';
import { getAnthropicClient, AnthropicKeyError } from '../anthropic';

// Use Sonnet for all extraction — fast, cheap, good at structured output
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 4096;

// ============================================================
// ZOD SCHEMAS FOR LLM OUTPUT VALIDATION
// ============================================================

const IdeaSchema = z.array(z.object({
  summary: z.string().min(10),
  context: z.string(),
  category: z.enum(['product', 'technical', 'strategic', 'personal', 'creative', 'research']).catch('other' as any),
  importanceScore: z.number().min(0).max(1),
  sourceQuote: z.string().optional(),
}));

const IntentSchema = z.object({
  inferredIntent: z.string().min(5),
  intentCategory: z.string(),
  intentConfidence: z.number().min(0).max(1),
});

const DriftSchema = z.object({
  actualOutcome: z.string(),
  outcomeCategory: z.string(),
  driftScore: z.number().min(0).max(1),
  driftCategory: z.enum(['on_track', 'productive_drift', 'rabbit_hole', 'context_switch', 'exploratory']).catch('exploratory' as any),
  trajectory: z.array(z.object({
    topic: z.string(),
    messageRange: z.tuple([z.number(), z.number()]),
  })).catch([]),
});

const ActionItemSchema = z.array(z.object({
  description: z.string().min(5),
  priority: z.string().optional(),
}));

const EfficiencySchema = z.object({
  efficiencyScore: z.number().min(0).max(1).nullable(),
  clarificationRounds: z.number(),
  contextQuality: z.number().min(0).max(1).nullable(),
  lessons: z.array(z.object({
    summary: z.string(),
    context: z.string(),
    worked: z.boolean(),
  })).catch([]),
});

interface ConversationData {
  id: string;
  userId: string;
  messages: { role: string; content: string; sequence: number }[];
}

interface SkillResult<T> {
  data: T | null;
  error: string | null;
  durationMs: number;
}

// ============================================================
// AUDIT TRAIL LOGGING
// ============================================================

/**
 * Log a skill execution to the audit_log table.
 * Every operation on user data is recorded for transparency.
 *
 * @param supabase - Service client instance
 * @param entry - Audit log entry fields
 */
async function logAudit(
  supabase: ReturnType<typeof createServiceClient>,
  entry: {
    userId: string;
    skillName: string;
    action: string;
    conversationId?: string;
    dataType?: string;
    destination?: string;
    details?: Record<string, unknown>;
    durationMs?: number;
  }
) {
  try {
    await supabase.from('audit_log').insert({
      user_id: entry.userId,
      skill_name: entry.skillName,
      action: entry.action,
      conversation_id: entry.conversationId || null,
      data_type: entry.dataType || null,
      destination: entry.destination || 'cloud',
      details: entry.details || {},
      duration_ms: entry.durationMs || null,
    });
  } catch (err) {
    // Audit logging should never break the pipeline
    console.warn('[Kairos Engine] Audit log write failed:', err);
  }
}

// ============================================================
// SKILL RUNNERS
// ============================================================

async function runSkill<T>(
  client: Anthropic,
  prompt: string,
  skillName: string,
  schema?: import('zod').ZodType<T>
): Promise<SkillResult<T>> {
  const start = Date.now();
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Parse JSON response, stripping any markdown fences
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Validate against schema if provided
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        console.warn(`[Kairos Engine] Skill "${skillName}" schema validation failed:`, result.error.issues);
        // Return the raw data but log the validation failures — don't crash the pipeline
        return { data: parsed as T, error: `Schema validation: ${result.error.issues.length} issues`, durationMs: Date.now() - start };
      }
      return { data: result.data, error: null, durationMs: Date.now() - start };
    }

    return { data: parsed as T, error: null, durationMs: Date.now() - start };
  } catch (error) {
    console.error(`[Kairos Engine] Skill "${skillName}" failed:`, error);
    return { data: null, error: String(error), durationMs: Date.now() - start };
  }
}

// ============================================================
// MAIN ANALYSIS PIPELINE
// ============================================================

export async function analyzeConversation(conversation: ConversationData) {
  const supabase = createServiceClient();
  const startTime = Date.now();

  // Resolve API key for this user (user key > server env var > error)
  const anthropic = await getAnthropicClient(conversation.userId);

  console.log(`[Kairos Engine] Analyzing conversation ${conversation.id}`);

  // Mark as processing
  await supabase
    .from('conversations')
    .update({ analysis_status: 'processing' })
    .eq('id', conversation.id);

  const formattedConvo = formatConversationForPrompt(conversation.messages);
  const formattedFirst = formatFirstMessages(conversation.messages);

  try {
    // ================================================================
    // PHASE A: Run independent skills in parallel (Skills 1, 2, 4)
    // Skill 3 depends on Skill 2, Skill 5 benefits from Skill 1
    // ================================================================

    const [ideasResult, intentResult, actionResult, efficiencyResult] = await Promise.all([
      // Skill 1: Extract Ideas
      runSkill<Array<{
        summary: string;
        context: string;
        category: string;
        importanceScore: number;
      }>>(
        anthropic,
        IDEA_EXTRACTOR_PROMPT.replace('{conversation}', formattedConvo),
        'idea-extractor'
      ),
      // Skill 2: Classify Intent
      runSkill<{
        inferredIntent: string;
        intentCategory: string;
        intentConfidence: number;
      }>(
        anthropic,
        INTENT_CLASSIFIER_PROMPT.replace('{firstMessages}', formattedFirst),
        'intent-classifier'
      ),
      // Skill 4: Extract Action Items
      runSkill<Array<{
        description: string;
        priority: string;
      }>>(
        anthropic,
        ACTION_ITEM_PROMPT.replace('{conversation}', formattedConvo),
        'action-item-extractor'
      ),
      // Skill 6: Prompt Efficiency Analysis
      runSkill<{
        efficiencyScore: number | null;
        clarificationRounds: number;
        contextQuality: number | null;
        lessons: Array<{ summary: string; context: string; worked: boolean }>;
      }>(
        anthropic,
        PROMPT_EFFICIENCY_PROMPT.replace('{conversation}', formattedConvo),
        'prompt-efficiency-analyzer'
      ),
    ]);

    // Audit logs for Phase A (parallel)
    await Promise.all([
      logAudit(supabase, {
        userId: conversation.userId,
        skillName: 'idea-extractor',
        action: ideasResult.data ? 'analyze' : 'error',
        conversationId: conversation.id,
        dataType: 'conversation',
        destination: 'claude_api',
        details: {
          items_extracted: ideasResult.data?.length || 0,
          error: ideasResult.error,
          model: MODEL,
        },
        durationMs: ideasResult.durationMs,
      }),
      logAudit(supabase, {
        userId: conversation.userId,
        skillName: 'intent-classifier',
        action: intentResult.data ? 'analyze' : 'error',
        conversationId: conversation.id,
        dataType: 'conversation',
        destination: 'claude_api',
        details: {
          intent_category: intentResult.data?.intentCategory || null,
          confidence: intentResult.data?.intentConfidence || null,
          error: intentResult.error,
          model: MODEL,
        },
        durationMs: intentResult.durationMs,
      }),
      logAudit(supabase, {
        userId: conversation.userId,
        skillName: 'action-item-extractor',
        action: actionResult.data ? 'analyze' : 'error',
        conversationId: conversation.id,
        dataType: 'conversation',
        destination: 'claude_api',
        details: {
          items_extracted: actionResult.data?.length || 0,
          error: actionResult.error,
          model: MODEL,
        },
        durationMs: actionResult.durationMs,
      }),
      logAudit(supabase, {
        userId: conversation.userId,
        skillName: 'prompt-efficiency-analyzer',
        action: efficiencyResult.data ? 'analyze' : 'error',
        conversationId: conversation.id,
        dataType: 'conversation',
        destination: 'claude_api',
        details: {
          efficiency_score: efficiencyResult.data?.efficiencyScore ?? null,
          clarification_rounds: efficiencyResult.data?.clarificationRounds ?? null,
          context_quality: efficiencyResult.data?.contextQuality ?? null,
          lessons_count: efficiencyResult.data?.lessons?.length || 0,
          error: efficiencyResult.error,
          model: MODEL,
        },
        durationMs: efficiencyResult.durationMs,
      }),
    ]);

    // ================================================================
    // PHASE B: Batch DB inserts + dependent Skill 3 (drift)
    // Insert ideas first so Skill 5 can see them in the DB
    // ================================================================

    // Batch insert ideas
    if (ideasResult.data && ideasResult.data.length > 0) {
      await supabase.from('ideas').insert(
        ideasResult.data.map(idea => ({
          user_id: conversation.userId,
          conversation_id: conversation.id,
          summary: idea.summary,
          context: idea.context,
          category: idea.category,
          importance_score: idea.importanceScore,
        }))
      );
    }

    // Batch insert action items
    if (actionResult.data && actionResult.data.length > 0) {
      await supabase.from('action_items').insert(
        actionResult.data.map(item => ({
          user_id: conversation.userId,
          conversation_id: conversation.id,
          description: item.description,
        }))
      );
    }

    // Store prompt efficiency results
    if (efficiencyResult.data && efficiencyResult.data.efficiencyScore !== null) {
      // Store efficiency metrics in conversation metadata (no migration needed)
      await supabase
        .from('conversations')
        .update({
          metadata: {
            prompt_efficiency: {
              score: efficiencyResult.data.efficiencyScore,
              clarification_rounds: efficiencyResult.data.clarificationRounds,
              context_quality: efficiencyResult.data.contextQuality,
            },
          },
        })
        .eq('id', conversation.id);

      // Store lessons as ideas with category "prompt_lesson"
      if (efficiencyResult.data.lessons.length > 0) {
        await supabase.from('ideas').insert(
          efficiencyResult.data.lessons.map(lesson => ({
            user_id: conversation.userId,
            conversation_id: conversation.id,
            summary: lesson.summary,
            context: lesson.context,
            category: 'prompt_lesson',
            importance_score: lesson.worked ? 0.6 : 0.7,
          }))
        );
      }
    }

    // Skill 3: Analyze Drift (depends on Skill 2 intent result)
    let driftResult: SkillResult<{
      actualOutcome: string;
      outcomeCategory: string;
      driftScore: number;
      driftCategory: string;
      trajectory: Array<{ topic: string; messageRange: [number, number] }>;
    }> = { data: null, error: null, durationMs: 0 };

    if (intentResult.data) {
      driftResult = await runSkill(
        anthropic,
        DRIFT_ANALYZER_PROMPT
          .replace('{intent}', intentResult.data.inferredIntent)
          .replace('{conversation}', formattedConvo),
        'drift-analyzer'
      );

      await logAudit(supabase, {
        userId: conversation.userId,
        skillName: 'drift-analyzer',
        action: driftResult.data ? 'analyze' : 'error',
        conversationId: conversation.id,
        dataType: 'conversation',
        destination: 'claude_api',
        details: {
          drift_score: driftResult.data?.driftScore || null,
          drift_category: driftResult.data?.driftCategory || null,
          trajectory_length: driftResult.data?.trajectory?.length || 0,
          error: driftResult.error,
          model: MODEL,
        },
        durationMs: driftResult.durationMs,
      });

      if (driftResult.data) {
        await supabase.from('drift_reports').insert({
          conversation_id: conversation.id,
          user_id: conversation.userId,
          inferred_intent: intentResult.data.inferredIntent,
          intent_category: intentResult.data.intentCategory,
          intent_confidence: intentResult.data.intentConfidence,
          actual_outcome: driftResult.data.actualOutcome,
          outcome_category: driftResult.data.outcomeCategory,
          drift_score: driftResult.data.driftScore,
          drift_category: driftResult.data.driftCategory,
          trajectory: driftResult.data.trajectory,
        });
      }
    }

    // ================================================================
    // PHASE C: Skill 5 — Revisit Moments (benefits from ideas in DB)
    // ================================================================

    const { data: existingIdeas } = await supabase
      .from('ideas')
      .select('summary, category')
      .eq('user_id', conversation.userId)
      .order('created_at', { ascending: false })
      .limit(50);

    const revisitResult = await runSkill<Array<{
      title: string;
      observation: string;
      implication: string;
      experiment: string | null;
      reason: string;
      importanceScore: number;
    }>>(
      anthropic,
      REVISIT_MOMENT_PROMPT
        .replace('{existingIdeas}', formatIdeasForContext(existingIdeas || []))
        .replace('{conversation}', formattedConvo),
      'revisit-moment-detector'
    );

    await logAudit(supabase, {
      userId: conversation.userId,
      skillName: 'revisit-moment-detector',
      action: revisitResult.data ? 'analyze' : 'error',
      conversationId: conversation.id,
      dataType: 'conversation',
      destination: 'claude_api',
      details: {
        items_extracted: revisitResult.data?.length || 0,
        existing_ideas_context: existingIdeas?.length || 0,
        error: revisitResult.error,
        model: MODEL,
      },
      durationMs: revisitResult.durationMs,
    });

    if (revisitResult.data && revisitResult.data.length > 0) {
      await supabase.from('revisit_moments').insert(
        revisitResult.data.map(moment => {
          // Compose description from OIE components
          const description = [
            moment.observation,
            moment.implication,
            moment.experiment,
          ].filter(Boolean).join(' ');

          return {
            user_id: conversation.userId,
            conversation_id: conversation.id,
            title: moment.title,
            description,
            reason: moment.reason,
            importance_score: moment.importanceScore,
          };
        })
      );
    }

    // ---- Mark as completed ----
    await supabase
      .from('conversations')
      .update({
        analysis_status: 'completed',
        analyzed_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);

    const totalMs = Date.now() - startTime;
    console.log(`[Kairos Engine] Analysis complete in ${totalMs}ms`);

    const skillSummary = {
      ideas: ideasResult.data?.length || 0,
      intent: !!intentResult.data,
      drift: !!driftResult.data,
      actionItems: actionResult.data?.length || 0,
      revisitMoments: revisitResult.data?.length || 0,
      promptEfficiency: efficiencyResult.data?.efficiencyScore ?? null,
    };

    // Audit: pipeline completion
    await logAudit(supabase, {
      userId: conversation.userId,
      skillName: 'pipeline',
      action: 'complete',
      conversationId: conversation.id,
      dataType: 'conversation',
      destination: 'cloud',
      details: {
        message_count: conversation.messages.length,
        skills: skillSummary,
        model: MODEL,
      },
      durationMs: totalMs,
    });

    return {
      success: true,
      processingTimeMs: totalMs,
      skills: skillSummary,
    };

  } catch (error) {
    const isKeyError = error instanceof AnthropicKeyError;
    console.error(`[Kairos Engine] Pipeline failed${isKeyError ? ' (no API key)' : ''}:`, error);

    // Audit: pipeline failure
    await logAudit(supabase, {
      userId: conversation.userId,
      skillName: 'pipeline',
      action: 'error',
      conversationId: conversation.id,
      dataType: 'conversation',
      destination: 'cloud',
      details: {
        error: String(error),
        errorType: isKeyError ? 'api_key_missing' : 'pipeline_error',
        message_count: conversation.messages.length,
      },
      durationMs: Date.now() - startTime,
    });

    await supabase
      .from('conversations')
      .update({ analysis_status: 'failed' })
      .eq('id', conversation.id);

    return { success: false, error: String(error) };
  }
}

// ============================================================
// BATCH ANALYSIS (Cron/Heartbeat)
// ============================================================

export async function processPendingConversations(limit = 5) {
  const supabase = createServiceClient();

  const { data: pending } = await supabase
    .from('conversations')
    .select('id, user_id')
    .eq('analysis_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (!pending || pending.length === 0) return { processed: 0 };

  const results = [];
  for (const conv of pending) {
    const { data: messages } = await supabase
      .from('messages')
      .select('role, content, sequence')
      .eq('conversation_id', conv.id)
      .order('sequence');

    if (messages && messages.length > 0) {
      const result = await analyzeConversation({
        id: conv.id,
        userId: conv.user_id,
        messages,
      });
      results.push(result);
    }
  }

  return { processed: results.length, results };
}
