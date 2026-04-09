/**
 * Import projects + memories from Claude Desktop export.
 * Matches conversations to projects via name/summary/description overlap.
 *
 * Data source: data-2026-03-06-02-18-18-batch-0000/
 *   - projects.json: 11 projects with names, descriptions, docs
 *   - memories.json: Claude's memory of user + per-project memories
 *   - conversations.json: conversation names + summaries for matching
 */

import { readFile } from 'node:fs/promises';
import { from, rpc } from './src/db.js';

const DATA_DIR = process.argv[2] || 'data-2026-03-06-02-18-18-batch-0000';

const sbHeaders = {};  // db.ts handles headers

async function getUserId() {
  if (process.env.KAIROS_USER_ID) return process.env.KAIROS_USER_ID;
  const { data } = await from("users").select("id").limit(1).maybeSingle();
  if (!data) { console.error("No user found"); process.exit(1); }
  return data.id;
}

const userId = await getUserId();

console.log('=== Import Projects + Memories ===\n');

// ── Load export data ──────────────────────────────────────────────────

const projects = JSON.parse(await readFile(`${DATA_DIR}/projects.json`, 'utf-8'));
const memories = JSON.parse(await readFile(`${DATA_DIR}/memories.json`, 'utf-8'));
const conversations = JSON.parse(await readFile(`${DATA_DIR}/conversations.json`, 'utf-8'));

console.log(`Projects: ${projects.length}`);
console.log(`Conversations: ${conversations.length}`);

const mem = memories[0];
const conversationMemory = mem.conversations_memory || '';
const projectMemories = mem.project_memories || {};

console.log(`Conversation memory: ${conversationMemory.length} chars`);
console.log(`Project memories: ${Object.keys(projectMemories).length}\n`);

// ── Import projects ───────────────────────────────────────────────────

let projectsImported = 0;
let projectsSkipped = 0;
const projectMap = new Map(); // export UUID → Supabase UUID

for (const p of projects) {
  // Skip starter projects
  if (p.is_starter_project) {
    console.log(`  Skipping starter: "${p.name}"`);
    projectsSkipped++;
    continue;
  }

  // Check if already exists
  const { data: existing } = await from("projects")
    .select("id")
    .eq("user_id", userId)
    .eq("label", p.name)
    .maybeSingle();

  if (existing) {
    projectMap.set(p.uuid, existing.id);
    projectsSkipped++;
    continue;
  }

  // Get project memory if available
  const projMem = projectMemories[p.uuid] || '';

  const { data: rows, error } = await from("projects")
    .insert({
      user_id: userId,
      label: p.name,
      description: [p.description, projMem].filter(Boolean).join('\n\n'),
      status: 'active',
      first_seen_at: p.created_at,
      last_seen_at: p.updated_at,
    });

  const row = Array.isArray(rows) ? rows[0] : rows;

  if (error || !row) {
    console.error(`  Failed to import "${p.name}": ${error?.message}`);
    continue;
  }

  projectMap.set(p.uuid, row.id);
  projectsImported++;
  console.log(`  Imported: "${p.name}" → ${row.id}`);
}

console.log(`\nProjects: ${projectsImported} imported, ${projectsSkipped} skipped`);
console.log(`Project map: ${projectMap.size} entries\n`);

// ── Match conversations to projects ───────────────────────────────────

// Build keyword mappings from project names + descriptions
const projectKeywords = new Map();
for (const p of projects) {
  if (p.is_starter_project) continue;
  const supaId = projectMap.get(p.uuid);
  if (!supaId) continue;

  const keywords = [];
  // Project name words
  keywords.push(...p.name.toLowerCase().split(/\s+/));
  // Description words (if available)
  if (p.description) keywords.push(...p.description.toLowerCase().split(/\s+/).slice(0, 20));
  // Project memory content
  const projMem = projectMemories[p.uuid] || '';
  if (projMem) keywords.push(...projMem.toLowerCase().split(/\s+/).slice(0, 30));

  projectKeywords.set(supaId, {
    name: p.name,
    keywords: new Set(keywords.filter(w => w.length > 3)),
  });
}

// Get conversation IDs from Supabase (map by platform_conversation_id)
const { data: dbConvos } = await from("conversations")
  .select("id, platform_conversation_id, title")
  .eq("user_id", userId);

const convoIdMap = new Map();
for (const c of (dbConvos || [])) {
  convoIdMap.set(c.platform_conversation_id, c.id);
}

// Match each conversation to projects
let linksCreated = 0;
let linksSkipped = 0;

// Define explicit matching rules based on observable patterns
const explicitMatches = {
  'Short Film - Attention': [
    '1. Exploring ADHD Concept in Cinema', '2. Understanding ADHD',
    '3. Exploring the attention struggle', '4. Reconstructing animated short film project',
    '5. Creating a red cube in Blender', '6. Exploring Attention',
    '7. Workflow', '8. Script Deep Dive', 'Scene-wise Workflow',
    'Developing Scene 2: Arrival',
  ],
  'Short Film - Exploring Darkness': [
    '1. CSA trauma and Intimacy struggles',
  ],
  'Job Applications': [
    'Anthropic Forward Deployed Engineer', 'Anthropic Engineer',
    'Anthropic Product Management', 'Assort Health Product Manager',
    'Assort Health Product Manager II', 'Agent Engineer Skills',
    'Liberate AI: Interview Prep', 'AI/ML career opportunities in high-growth tech',
    'Career Growth Strategy',
  ],
  'Kairos': [
    'Kairos - Market Research', 'Kairos - Project Plan',
    'Connecting Claude Code with Project Files',
  ],
  'Low Cost Pupilometry Solution': [],  // no conversations match in this export
  'AI/ML Knowledge Database': [
    'Formal Verification and LLMs', 'MCP vs LangGraph in MAS',
    'Understanding OpenClaw agentic architecture',
  ],
  'Podcast': [],
  'Career Trajectory Navigator': [],
  'AI Investment Recommender': [],
  'The Elements of Quantitative Investing': [],
};

// Also do fuzzy matching for conversations not explicitly matched
const explicitlyMatched = new Set();
for (const convoNames of Object.values(explicitMatches)) {
  for (const name of convoNames) explicitlyMatched.add(name);
}

for (const [projectName, convoNames] of Object.entries(explicitMatches)) {
  // Find project in our map
  let projectId = null;
  for (const [supaId, info] of projectKeywords) {
    if (info.name === projectName) { projectId = supaId; break; }
  }
  if (!projectId) continue;

  for (const convoName of convoNames) {
    // Find conversation in DB
    const exportConvo = conversations.find(c => c.name === convoName);
    if (!exportConvo) continue;

    const dbConvoId = convoIdMap.get(exportConvo.uuid);
    if (!dbConvoId) continue;

    // Create link
    const { error } = await from("conversation_projects")
      .insert({
        conversation_id: dbConvoId,
        project_id: projectId,
        confidence: 0.95,
        source: 'inferred',
      });

    if (error) {
      if (error.code === '23505') linksSkipped++; // duplicate
      // else: other error, ignore
    } else {
      linksCreated++;
    }
  }
}

// Fuzzy match remaining conversations to projects
for (const c of conversations) {
  if (explicitlyMatched.has(c.name)) continue;
  if (!c.name && !c.summary) continue;

  const dbConvoId = convoIdMap.get(c.uuid);
  if (!dbConvoId) continue;

  const text = `${c.name || ''} ${(c.summary || '').slice(0, 200)}`.toLowerCase();
  const words = new Set(text.split(/\s+/).filter(w => w.length > 3));

  // Score against each project
  let bestProject = null;
  let bestScore = 0;

  for (const [projectId, info] of projectKeywords) {
    const overlap = [...info.keywords].filter(w => words.has(w)).length;
    const score = overlap / Math.max(1, info.keywords.size);
    if (score > bestScore && score > 0.15) { // minimum 15% keyword overlap
      bestScore = score;
      bestProject = projectId;
    }
  }

  if (bestProject) {
    const { error } = await from("conversation_projects")
      .insert({
        conversation_id: dbConvoId,
        project_id: bestProject,
        confidence: Math.round(bestScore * 100) / 100,
        source: 'inferred',
      });

    if (error) {
      if (error.code === '23505') linksSkipped++;
    } else {
      linksCreated++;
      const projInfo = [...projectKeywords.entries()].find(([id]) => id === bestProject)?.[1];
      console.log(`  Fuzzy: "${c.name || 'Untitled'}" → "${projInfo?.name}" (${(bestScore*100).toFixed(0)}%)`);
    }
  }
}

console.log(`\nConversation-project links: ${linksCreated} created, ${linksSkipped} skipped`);

// ── Store conversation memory on user profile ─────────────────────────

if (conversationMemory) {
  await from("users")
    .update({
      attention_profile: {
        claude_memory: conversationMemory,
        imported_at: new Date().toISOString(),
      },
    })
    .eq("id", userId);
  console.log(`\nStored conversation memory on user profile (${conversationMemory.length} chars)`);
}

// ── Summary ───────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
const { data: projCount } = await from("projects")
  .select("id")
  .eq("user_id", userId);
const { data: linkCount } = await from("conversation_projects")
  .select("conversation_id");
console.log(`Total projects in DB: ${projCount?.length || 0}`);
console.log(`Total conversation-project links: ${linkCount?.length || 0}`);
