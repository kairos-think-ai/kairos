/**
 * Memory Curator — Populates the entity + connection graph.
 * OpenSage-inspired: dedicated post-analysis step that decides
 * what entities and connections to create from existing ideas.
 *
 * Steps:
 * 1. Extract entities from all ideas (people, technologies, concepts, etc.)
 * 2. Create entity_mentions linking entities to conversations
 * 3. Create conversation_connections based on shared entities + topic similarity
 * 4. Enroll high-importance ideas into SM-2 resurfacing
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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


async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
}

// ================================================================
// STEP 1: Extract entities from ideas using Claude
// ================================================================

console.log('=== Memory Curator: Populating Entity + Connection Graph ===\n');

// Get all ideas grouped by conversation
const ideas = await sb(
  `ideas?select=id,summary,context,category,importance_score,conversation_id&user_id=eq.${USER_ID}&order=conversation_id`
);
console.log(`Total ideas to process: ${ideas.length}`);

// Get conversations for context
const conversations = await sb(
  `conversations?select=id,title,platform,started_at&user_id=eq.${USER_ID}&analysis_status=eq.completed`
);
const convoMap = new Map(conversations.map(c => [c.id, c]));
console.log(`Conversations with completed analysis: ${conversations.length}`);

// Batch ideas by conversation for entity extraction
const ideasByConvo = {};
for (const idea of ideas) {
  if (!ideasByConvo[idea.conversation_id]) ideasByConvo[idea.conversation_id] = [];
  ideasByConvo[idea.conversation_id].push(idea);
}

const ENTITY_PROMPT = (convoTitle, ideaSummaries) => `Extract named entities from these ideas that were discussed in the conversation "${convoTitle}".

Ideas:
${ideaSummaries}

Return a JSON array of entities. Each entity: { name (canonical form), type (one of: person, technology, concept, project_name, tool, company, decision, goal, other), aliases (array of alternate names, can be empty) }

Rules:
- Deduplicate: "React" and "ReactJS" should be one entity with aliases
- Be specific: "OAuth" not just "authentication"
- Include decisions and goals as entities
- Only extract entities actually mentioned, don't infer

Return ONLY valid JSON array.`;

let totalEntities = 0;
let totalMentions = 0;
const entityIndex = new Map(); // name+type -> entity id

// Check existing entities to avoid duplicates
const existingEntities = await sb(
  `entities?select=id,name,type&user_id=eq.${USER_ID}`
);
for (const e of existingEntities) {
  entityIndex.set(`${e.name.toLowerCase()}:${e.type}`, e.id);
}
console.log(`Existing entities: ${existingEntities.length}\n`);

const convoIds = Object.keys(ideasByConvo);
for (let i = 0; i < convoIds.length; i++) {
  const convoId = convoIds[i];
  const convo = convoMap.get(convoId);
  const convoIdeas = ideasByConvo[convoId];

  if (!convo || convoIdeas.length === 0) continue;

  process.stdout.write(`[${i + 1}/${convoIds.length}] "${convo.title || 'Untitled'}" (${convoIdeas.length} ideas)... `);

  try {
    const summaries = convoIdeas.map((idea, j) => `${j + 1}. [${idea.category}] ${idea.summary}`).join('\n');
    const entities = await callClaude(ENTITY_PROMPT(convo.title || 'Untitled', summaries));

    if (!Array.isArray(entities)) { console.log('skip (bad response)'); continue; }

    for (const entity of entities) {
      const key = `${entity.name.toLowerCase()}:${entity.type}`;

      let entityId = entityIndex.get(key);

      if (!entityId) {
        // Create new entity
        const [row] = await sb('entities', {
          method: 'POST',
          body: JSON.stringify({
            user_id: USER_ID,
            name: entity.name,
            type: entity.type || 'other',
            aliases: entity.aliases || [],
            first_mentioned_at: convo.started_at,
            last_mentioned_at: convo.started_at,
            mention_count: 1,
          }),
          headers: { ...sbHeaders, Prefer: 'return=representation' },
        });
        entityId = row.id;
        entityIndex.set(key, entityId);
        totalEntities++;
      } else {
        // Update mention count
        await sb(`entities?id=eq.${entityId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            mention_count: existingEntities.find(e => e.id === entityId)?.mention_count + 1 || 2,
            last_mentioned_at: convo.started_at,
          }),
          headers: { ...sbHeaders, Prefer: 'return=minimal' },
        });
      }

      // Create entity mention
      await sb('entity_mentions', {
        method: 'POST',
        body: JSON.stringify({
          entity_id: entityId,
          conversation_id: convoId,
          context: convoIdeas[0].summary.slice(0, 200),
          sentiment: 'neutral',
        }),
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
      }).catch(() => {}); // ignore duplicate mentions
      totalMentions++;
    }

    console.log(`${entities.length} entities`);
  } catch (err) {
    console.log(`error: ${err.message.slice(0, 80)}`);
  }
}

console.log(`\nEntities created: ${totalEntities}, Mentions created: ${totalMentions}`);

// ================================================================
// STEP 2: Create conversation connections from shared entities
// ================================================================

console.log('\n=== Building Conversation Connections ===\n');

// Get all entity mentions
const allMentions = await sb(
  `entity_mentions?select=entity_id,conversation_id&limit=5000`
);

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

console.log(`Found ${connectionPairs.size} conversation pairs with shared entities`);

let connectionsCreated = 0;
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
    connectionsCreated++;
  } catch (err) {
    // Likely duplicate - skip
  }
}

console.log(`Connections created: ${connectionsCreated}`);

// ================================================================
// STEP 3: Enroll high-importance ideas in SM-2 resurfacing
// ================================================================

console.log('\n=== Enrolling Ideas in SM-2 Resurfacing ===\n');

const highImportanceIdeas = ideas.filter(i => i.importance_score >= 0.7);
console.log(`High-importance ideas (>=0.7): ${highImportanceIdeas.length}`);

let enrolled = 0;
for (const idea of highImportanceIdeas) {
  try {
    await sb('idea_resurfacing', {
      method: 'POST',
      body: JSON.stringify({
        user_id: USER_ID,
        idea_id: idea.id,
        interval_days: 1,
        ease_factor: 2.5,
        next_surface_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        enrollment_reason: 'high_importance',
        is_active: true,
      }),
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
    });
    enrolled++;
  } catch (err) {
    // Likely duplicate
  }
}

console.log(`Ideas enrolled in resurfacing: ${enrolled}`);

// ================================================================
// Final summary
// ================================================================

console.log('\n=== Memory Curator Complete ===');
const finalEntities = await fetch(`${SUPABASE_URL}/rest/v1/entities?select=id&user_id=eq.${USER_ID}`, {
  headers: { ...sbHeaders, Prefer: 'count=exact' },
});
const finalConnections = await fetch(`${SUPABASE_URL}/rest/v1/conversation_connections?select=id&user_id=eq.${USER_ID}`, {
  headers: { ...sbHeaders, Prefer: 'count=exact' },
});
const finalResurfacing = await fetch(`${SUPABASE_URL}/rest/v1/idea_resurfacing?select=id&user_id=eq.${USER_ID}`, {
  headers: { ...sbHeaders, Prefer: 'count=exact' },
});

console.log(`Entities: ${finalEntities.headers.get('content-range')}`);
console.log(`Connections: ${finalConnections.headers.get('content-range')}`);
console.log(`Ideas in resurfacing: ${finalResurfacing.headers.get('content-range')}`);
