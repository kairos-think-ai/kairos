// ============================================================
// Kairos Shared Types
// Used by both the Extension (Node) and Web App (Gateway)
// ============================================================

export type Platform = 'claude' | 'chatgpt' | 'gemini' | 'openclaw' | 'other';

/** Privacy tier: Mirror (local only) or Analyst (cloud analysis) */
export type PrivacyTier = 'mirror' | 'analyst';

export interface CapturedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  sequence: number;
}

export interface ConversationPayload {
  platform: Platform;
  platformConversationId: string;
  title: string | null;
  url: string;
  messages: CapturedMessage[];
  metadata?: Record<string, unknown>;
  capturedAt: string;
}

export interface IngestRequest {
  conversations: ConversationPayload[];
}

export interface IngestResponse {
  ingested: number;
  errors: string[];
}

export interface ExtractedIdea {
  summary: string;
  context: string;
  category: 'product' | 'technical' | 'strategic' | 'personal' | 'creative' | 'research';
  importanceScore: number;
}

export interface DriftReport {
  inferredIntent: string;
  intentCategory: string;
  intentConfidence: number;
  actualOutcome: string;
  outcomeCategory: string;
  driftScore: number;
  driftCategory: 'on_track' | 'productive_drift' | 'rabbit_hole' | 'context_switch' | 'exploratory';
  trajectory: { topic: string; messageRange: [number, number] }[];
}

export interface ActionItem {
  description: string;
  priority: 'high' | 'medium' | 'low';
}

export interface RevisitMoment {
  title: string;
  description: string;
  reason: 'high_engagement' | 'never_followed_up' | 'contradiction' | 'recurring_theme' | 'decision_unmade' | 'connection_found';
  importanceScore: number;
}

export interface AnalysisResult {
  conversationId: string;
  ideas: ExtractedIdea[];
  driftReport: DriftReport;
  actionItems: ActionItem[];
  revisitMoments: RevisitMoment[];
  processingTimeMs: number;
}

export interface ExtensionState {
  isCapturing: boolean;
  platformsEnabled: Platform[];
  conversationsCapturedToday: number;
  lastSyncAt: string | null;
  authToken: string | null;
  gatewayUrl: string;
  privacyTier: PrivacyTier | null;
  totalLocalConversations: number;
  pendingSync: number;
}

// Re-export intercept types for cross-world communication
export type { InterceptedConversation, InterceptedStreamingUpdate } from './intercept';
export { KAIROS_MSG_PREFIX, isValidInterceptedPayload } from './intercept';
