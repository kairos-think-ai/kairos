/**
 * Build conversation connections from shared entities.
 * This is Step 2 of the curator that failed when internet dropped.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...sbHeaders, ...opts.headers }, ...opts });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getDefaultUserId() {
  const [user] = await sb('users?select=id&limit=1');
  if (!user) { console.error('No user found.'); process.exit(1); }
  return user.id;
}
const USER_ID = process.env.KAIROS_USER_ID || await getDefaultUserId();

console.log('=== Building Conversation Connections ===\n');

// Get all entity mentions
const allMentions = await sb(`entity_mentions?select=entity_id,conversation_id&limit=5000`);
console.log(`Entity mentions: ${allMentions.length}`);

// Build entity -> conversations map
const entityConvos = {};
for (const m of allMentions) {
  if (!entityConvos[m.entity_id]) entityConvos[m.entity_id] = new Set();
  entityConvos[m.entity_id].add(m.conversation_id);
}

// Find conversation pairs that share entities
const connectionPairs = new Map();
for (const [entityId, convoSet] of Object.entries(entityConvos)) {
  const convos = [...convoSet];
  for (let i = 0; i < convos.length; i++) {
    for (let j = i + 1; j < convos.length; j++) {
      const key = [convos[i], convos[j]].sort().join(':');
      if (!connectionPairs.has(key)) {
        connectionPairs.set(key, { a: convos[i], b: convos[j], sharedEntities: [] });
      }
      connectionPairs.get(key).sharedEntities.push(entityId);
    }
  }
}

console.log(`Conversation pairs with shared entities: ${connectionPairs.size}`);

let created = 0, skipped = 0;
for (const [key, pair] of connectionPairs) {
  const strength = Math.min(1.0, 0.3 + pair.sharedEntities.length * 0.1);
  try {
    await sb('conversation_connections', {
      method: 'POST',
      body: JSON.stringify({
        user_id: USER_ID,
        conversation_a_id: pair.a,
        conversation_b_id: pair.b,
        connection_type: 'shared_entity',
        strength,
        description: `${pair.sharedEntities.length} shared entities`,
      }),
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
    });
    created++;
  } catch {
    skipped++; // duplicate
  }
}

console.log(`\nConnections created: ${created}, Skipped (duplicates): ${skipped}`);

// Verify
const finalRes = await fetch(`${SUPABASE_URL}/rest/v1/conversation_connections?select=id&user_id=eq.${USER_ID}`, {
  headers: { ...sbHeaders, Prefer: 'count=exact' },
});
console.log(`Total connections in DB: ${finalRes.headers.get('content-range')}`);
