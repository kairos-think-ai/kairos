/**
 * Message-Level Embedding Generator
 *
 * Embeds individual messages using Voyage AI voyage-3 (1024 dimensions).
 * This is the prerequisite for all statistical methods:
 * - JSD drift detection
 * - TextTiling change points
 * - Information entropy (discovery/production mode)
 * - Cognitive Load Index
 * - Working memory constraint detection
 *
 * Cost: ~$0.00024 per conversation (~4000 tokens avg at $0.06/M tokens)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!VOYAGE_KEY) {
  console.error('Missing VOYAGE_API_KEY');
  process.exit(1);
}

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { ...sbHeaders, ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getDefaultUserId() {
  const [user] = await sb('users?select=id&limit=1');
  if (!user) { console.error('No user found.'); process.exit(1); }
  return user.id;
}

const USER_ID = process.env.KAIROS_USER_ID || await getDefaultUserId();

async function callEmbeddingAPI(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_KEY}`,
    },
    body: JSON.stringify({
      model: 'voyage-3',
      input: texts,
      input_type: 'document',
    }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// ── Main ──────────────────────────────────────────────────────────────

console.log('=== Message-Level Embedding Generator ===\n');

// Get all conversations
const conversations = await sb(
  `conversations?select=id,title,message_count&user_id=eq.${USER_ID}&analysis_status=eq.completed&order=started_at.asc`
);
console.log(`Conversations to process: ${conversations.length}`);

// Check which conversations already have message embeddings
let totalEmbedded = 0;
let totalSkipped = 0;
let totalErrors = 0;
let totalTokensEstimate = 0;

const BATCH_SIZE = 64; // Voyage supports 128 but keep batches moderate for reliability

for (let ci = 0; ci < conversations.length; ci++) {
  const convo = conversations[ci];

  // Check if this conversation already has embeddings
  const existingCheck = await sb(
    `messages?select=id&conversation_id=eq.${convo.id}&embedding=not.is.null&limit=1`
  );
  if (existingCheck && existingCheck.length > 0) {
    totalSkipped += convo.message_count;
    continue;
  }

  // Fetch messages without embeddings
  const messages = await sb(
    `messages?select=id,role,content,sequence&conversation_id=eq.${convo.id}&embedding=is.null&order=sequence.asc`
  );

  if (!messages || messages.length === 0) {
    continue;
  }

  process.stdout.write(
    `[${ci + 1}/${conversations.length}] "${convo.title || 'Untitled'}" (${messages.length} msgs)... `
  );

  try {
    // Prepare texts — prefix with role for better semantic separation
    const texts = messages.map((m) => {
      const prefix = m.role === 'user' ? '[User] ' : '[Assistant] ';
      // Truncate very long messages to ~2000 chars to stay within token limits
      const content = m.content.length > 2000 ? m.content.slice(0, 2000) + '...' : m.content;
      return prefix + content;
    });

    // Process in batches
    let batchEmbedded = 0;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batchTexts = texts.slice(i, i + BATCH_SIZE);
      const batchMsgs = messages.slice(i, i + BATCH_SIZE);

      const embeddings = await callEmbeddingAPI(batchTexts);

      // Store embeddings — batch update via individual PATCHes
      // (Supabase REST doesn't support bulk update by different IDs)
      for (let j = 0; j < batchMsgs.length; j++) {
        await sb(`messages?id=eq.${batchMsgs[j].id}`, {
          method: 'PATCH',
          body: JSON.stringify({ embedding: JSON.stringify(embeddings[j]) }),
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
        });
        batchEmbedded++;
      }

      // Estimate tokens (rough: 1 token ≈ 4 chars)
      totalTokensEstimate += batchTexts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    }

    totalEmbedded += batchEmbedded;
    console.log(`${batchEmbedded} embedded`);
  } catch (err) {
    console.log(`error: ${err.message.slice(0, 80)}`);
    totalErrors++;
  }
}

const estimatedCost = (totalTokensEstimate / 1_000_000) * 0.06; // Voyage voyage-3: $0.06/M tokens
console.log(`\n=== Done ===`);
console.log(`Embedded: ${totalEmbedded} messages`);
console.log(`Skipped: ${totalSkipped} (already had embeddings)`);
console.log(`Errors: ${totalErrors}`);
console.log(`Estimated tokens: ~${totalTokensEstimate.toLocaleString()}`);
console.log(`Estimated cost: ~$${estimatedCost.toFixed(4)}`);

// Verify
const embeddedCount = await fetch(
  `${SUPABASE_URL}/rest/v1/messages?select=id&embedding=not.is.null&user_id=eq.${USER_ID}`,
  { headers: { ...sbHeaders, Prefer: 'count=exact' } }
);
console.log(`Total messages with embeddings: ${embeddedCount.headers.get('content-range')}`);
