/**
 * Kairos Inngest Client
 *
 * Event-driven pipeline replacing Vercel cron.
 * Events flow: conversation/ingested → L2 analysis → conversation/analyzed → embeddings + clustering + session
 */

import { EventSchemas, Inngest } from 'inngest';

type Events = {
  'conversation/ingested': {
    data: {
      conversationId: string;
      userId: string;
      messageCount: number;
      platform: string;
    };
  };
  'conversation/analyzed': {
    data: {
      conversationId: string;
      userId: string;
      ideasExtracted: number;
      driftScore: number | null;
    };
  };
  'session/detected': {
    data: {
      sessionId: string;
      userId: string;
      conversationIds: string[];
    };
  };
};

export const inngest = new Inngest({
  id: 'kairos',
  schemas: new EventSchemas().fromRecord<Events>(),
});
