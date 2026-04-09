import { NextRequest, NextResponse } from 'next/server';
import { processPendingConversations } from '@/lib/kairos-engine/analyze';

/**
 * POST /api/analyze
 * 
 * Cron/Heartbeat endpoint. Triggers the analysis pipeline for
 * pending conversations. Call this from:
 * - Vercel Cron Jobs (recommended)
 * - Supabase Edge Functions
 * - Manual trigger from admin panel
 * 
 * Protected by a CRON_SECRET header to prevent unauthorized triggers.
 */
export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('Authorization');
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const limit = (body as any).limit || 5;

    const result = await processPendingConversations(limit);

    return NextResponse.json({
      processed: result.processed,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Analyze API] Error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
