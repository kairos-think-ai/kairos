'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import Sidebar from '@/components/Sidebar';
import { detectFormat, extractFromZip, isZipFile } from '@/lib/import/detect';
import {
  parseClaudeExport,
  parseChatGPTExport,
  parseClaudeCodeJSONL,
  parseOpenClaw,
  parseWithSchema,
  extractSkeleton,
  structuralSignature,
  type ConversationPayload,
  type ParseResult,
  type ImportFormat,
  type SchemaMapping,
} from '@/lib/import/parsers';

// ============================================================
// CONSTANTS
// ============================================================

const KAIROS_EXTENSION_ID = 'kefkcnhkjknampbbfpjljhmldnphjmjg';
const IMPORT_BATCH_SIZE = 3; // Reduced from 10 — large conversations can exceed Next.js body size limit

// ============================================================
// TYPES
// ============================================================

type ImportState = 'idle' | 'parsing' | 'analyzing' | 'preview' | 'importing' | 'complete' | 'processing' | 'done' | 'error';
type PrivacyTier = 'own' | 'trust' | null;

interface ParsedConversation extends ConversationPayload {
  selected: boolean;
  fileSource: string;
}

interface ImportProgress {
  total: number;
  completed: number;
  errors: string[];
}

// ============================================================
// MAIN PAGE
// ============================================================

export default function ImportPage() {
  // Auth & extension state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [privacyTier, setPrivacyTier] = useState<PrivacyTier>(null);
  const [extensionDetected, setExtensionDetected] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  // Import flow state
  const [state, setState] = useState<ImportState>('idle');
  const [conversations, setConversations] = useState<ParsedConversation[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress>({ total: 0, completed: 0, errors: [] });
  const [detectedFormat, setDetectedFormat] = useState<ImportFormat | null>(null);

  // Pipeline processing state
  const [pipelineSteps, setPipelineSteps] = useState<Array<{ name: string; status: string; count?: number; errors?: number }>>([]);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelineResult, setPipelineResult] = useState<any>(null);

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Init: Auth + Extension Detection ──────────────────────
  useEffect(() => {
    async function init() {
      const supabase = createBrowserSupabaseClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        setIsAuthenticated(false);
        return;
      }

      setIsAuthenticated(true);
      setAccessToken(session.access_token);

      // Detect extension
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage(
            KAIROS_EXTENSION_ID,
            { type: 'AUTH_TOKEN', access_token: session.access_token, expires_at: session.expires_at },
            (response: any) => {
              if (!chrome.runtime.lastError && response?.success) {
                setExtensionDetected(true);
                console.log('[Kairos Import] Extension detected, auth token sent');
              }
            }
          );

          // Send gateway URL so extension knows where to sync
          const gatewayUrl = window.location.origin;
          chrome.runtime.sendMessage(
            KAIROS_EXTENSION_ID,
            { type: 'SET_GATEWAY_URL', url: gatewayUrl },
            () => { /* ignore errors */ }
          );

          chrome.runtime.sendMessage(
            KAIROS_EXTENSION_ID,
            { type: 'GET_PRIVACY_TIER' },
            (response: any) => {
              if (!chrome.runtime.lastError && response?.success) {
                setPrivacyTier(response.tier || null);
              }
            }
          );
        }
      } catch {
        // Extension not installed
      }
    }

    init();
  }, []);

  // ── File Processing ───────────────────────────────────────

  const processFiles = useCallback(async (files: FileList | File[]) => {
    setState('parsing');
    setWarnings([]);
    setErrorMessage(null);

    const allConversations: ParsedConversation[] = [];
    const allWarnings: string[] = [];
    let lastFormat: ImportFormat = 'unknown';

    try {
      const fileArray = Array.from(files);

      for (const file of fileArray) {
        // Handle ZIP files
        if (isZipFile(file)) {
          try {
            const extracted = await extractFromZip(file);
            if (extracted.length === 0) {
              allWarnings.push(`${file.name}: No .json or .jsonl files found in ZIP`);
              continue;
            }

            for (const { name, content } of extracted) {
              const result = await parseFileContent(content, name);
              lastFormat = result.format;
              allWarnings.push(...result.warnings.map(w => `${file.name}/${name}: ${w}`));
              allConversations.push(
                ...result.conversations.map(c => ({
                  ...c,
                  selected: true,
                  fileSource: `${file.name}/${name}`,
                }))
              );
            }
          } catch (err) {
            allWarnings.push(`${file.name}: Failed to extract ZIP — ${String(err)}`);
          }
          continue;
        }

        // Handle JSON/JSONL files
        try {
          const content = await file.text();
          const result = await parseFileContent(content, file.name);
          lastFormat = result.format;
          allWarnings.push(...result.warnings.map(w => `${file.name}: ${w}`));
          allConversations.push(
            ...result.conversations.map(c => ({
              ...c,
              selected: true,
              fileSource: file.name,
            }))
          );
        } catch (err) {
          allWarnings.push(`${file.name}: Failed to read file — ${String(err)}`);
        }
      }

      if (allConversations.length === 0) {
        setState('error');
        setErrorMessage(
          allWarnings.length > 0
            ? `No conversations found. ${allWarnings[0]}`
            : 'No supported conversations found in the uploaded files. Supported formats: Claude.ai export (.json), ChatGPT export (.json), Claude Code sessions (.jsonl), OpenClaw sessions (.jsonl).'
        );
        return;
      }

      setConversations(allConversations);
      setWarnings(allWarnings);
      setDetectedFormat(lastFormat);
      setState('preview');
    } catch (err) {
      setState('error');
      setErrorMessage(`Unexpected error: ${String(err)}`);
    }
  }, [accessToken]);

  async function parseFileContent(content: string, fileName: string): Promise<ParseResult> {
    const format = detectFormat(content, fileName);

    switch (format) {
      case 'claude-export':
        return parseClaudeExport(content);
      case 'chatgpt-export':
        return parseChatGPTExport(content);
      case 'claude-code-jsonl':
        return parseClaudeCodeJSONL(content);
      case 'openclaw-workspace':
        return parseOpenClaw(content);
      default: {
        // ── AI Adaptive Parser: infer schema for unknown formats ──

        // Step 1: Check for a saved/learned schema
        const sig = structuralSignature(content);
        const savedSchema = typeof window !== 'undefined'
          ? localStorage.getItem(`kairos-schema-${sig}`)
          : null;

        if (savedSchema) {
          try {
            const schema = JSON.parse(savedSchema) as SchemaMapping;
            return parseWithSchema(content, schema);
          } catch {
            // Corrupted cache — fall through to AI inference
          }
        }

        // Step 2: Need auth for AI inference
        if (!accessToken) {
          return {
            conversations: [],
            warnings: ['Unknown format. Sign in to use AI-powered format detection.'],
            format: 'unknown',
          };
        }

        // Step 3: AI adaptive parser — infer schema from structural skeleton
        setState('analyzing');
        const skeleton = extractSkeleton(content);

        try {
          const res = await fetch('/api/infer-schema', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ sample: skeleton }),
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            if (res.status === 422 && errData.error === 'api_key_required') {
              return {
                conversations: [],
                warnings: ['An Anthropic API key is required to analyze unknown file formats. Please add your key in Settings.'],
                format: 'unknown',
              };
            }
            return {
              conversations: [],
              warnings: [`AI format detection failed: ${errData.error || res.statusText}`],
              format: 'unknown',
            };
          }

          const { schema } = await res.json() as { schema: SchemaMapping };

          // Step 4: Parse with the inferred schema
          const result = parseWithSchema(content, schema);

          // Step 5: If successful (>0 conversations), save the learned schema
          if (result.conversations.length > 0 && typeof window !== 'undefined') {
            localStorage.setItem(`kairos-schema-${sig}`, JSON.stringify(schema));
            result.warnings.push(
              `New format learned: "${schema.formatName}". Future imports of this format will be instant.`
            );
          }

          return result;
        } catch (err) {
          return {
            conversations: [],
            warnings: [`AI format detection error: ${String(err)}`],
            format: 'unknown',
          };
        }
      }
    }
  }

  // ── Import Execution ──────────────────────────────────────

  const startImport = useCallback(async () => {
    const selected = conversations.filter(c => c.selected);
    if (selected.length === 0) return;

    setState('importing');
    setProgress({ total: selected.length, completed: 0, errors: [] });

    const errors: string[] = [];
    let completed = 0;

    // Import in batches
    for (let i = 0; i < selected.length; i += IMPORT_BATCH_SIZE) {
      const batch = selected.slice(i, i + IMPORT_BATCH_SIZE);
      const payloads: ConversationPayload[] = batch.map(({ selected: _s, fileSource: _f, ...rest }) => rest);

      try {
        if (extensionDetected) {
          // Route through extension → IndexedDB (+ cloud sync if Analyst)
          await new Promise<void>((resolve, reject) => {
            chrome.runtime.sendMessage(
              KAIROS_EXTENSION_ID,
              { type: 'IMPORT_CONVERSATIONS', conversations: payloads },
              (response: any) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else if (response?.success) {
                  if (response.errors?.length) {
                    errors.push(...response.errors);
                  }
                  resolve();
                } else {
                  reject(new Error(response?.error || 'Import failed'));
                }
              }
            );
          });
        } else if (accessToken) {
          // Cloud-direct: POST to /api/ingest
          const response = await fetch('/api/ingest', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ conversations: payloads }),
          });

          if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            errors.push(`Batch ${Math.floor(i / IMPORT_BATCH_SIZE) + 1}: ${errData.error || response.statusText}`);
          } else {
            const result = await response.json();
            if (result.errors?.length) {
              errors.push(...result.errors);
            }
          }
        }
      } catch (err) {
        errors.push(`Batch ${Math.floor(i / IMPORT_BATCH_SIZE) + 1}: ${String(err)}`);
      }

      completed += batch.length;
      setProgress({ total: selected.length, completed, errors: [...errors] });

      // Yield to UI between batches
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    setProgress({ total: selected.length, completed: selected.length, errors });
    setState('complete');
  }, [conversations, extensionDetected, accessToken]);

  // ── Auto-Analyze After Import ────────────────────────────
  // When import completes, automatically trigger the analysis pipeline.
  // Shows a progress screen with step-by-step status.

  useEffect(() => {
    if (state !== 'complete') return;

    async function runPipeline() {
      setState('processing');
      setPipelineSteps([
        { name: 'Analyzing conversations', status: 'pending' },
        { name: 'Generating embeddings', status: 'pending' },
      ]);
      setPipelineError(null);

      try {
        const supabase = createBrowserSupabaseClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          setPipelineError('Not signed in. Please sign in and try again.');
          return;
        }

        setPipelineSteps(prev => prev.map((s, i) => i === 0 ? { ...s, status: 'running' } : s));

        const res = await fetch('/api/pipeline/trigger', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        const data = await res.json();

        if (!res.ok) {
          // API keys not configured — not a fatal error, just skip analysis
          if (res.status === 400 && data.error?.includes('API key')) {
            setPipelineSteps([
              { name: 'Analyzing conversations', status: 'skipped' },
              { name: 'Generating embeddings', status: 'skipped' },
            ]);
            setPipelineError('API keys not configured. Go to Settings to add your Anthropic and OpenAI keys, then re-run analysis from the dashboard.');
            setState('done');
            return;
          }
          setPipelineError(data.error || 'Pipeline failed');
          setState('done');
          return;
        }

        // Map pipeline results to steps
        const steps = (data.steps || []).map((step: any) => ({
          name: step.name,
          status: step.errors > 0 ? 'partial' : 'complete',
          count: step.count,
          errors: step.errors,
        }));
        setPipelineSteps(steps);
        setPipelineResult(data);
        setState('done');
      } catch (err) {
        setPipelineError(err instanceof Error ? err.message : 'Pipeline failed');
        setState('done');
      }
    }

    // Small delay so user sees "Import complete" before processing starts
    const timer = setTimeout(runPipeline, 1500);
    return () => clearTimeout(timer);
  }, [state]);

  // ── Drag & Drop Handlers ──────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }, [processFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
  }, [processFiles]);

  // ── Selection Helpers ─────────────────────────────────────

  const toggleAll = useCallback((selected: boolean) => {
    setConversations(prev => prev.map(c => ({ ...c, selected })));
  }, []);

  const toggleOne = useCallback((index: number) => {
    setConversations(prev =>
      prev.map((c, i) => (i === index ? { ...c, selected: !c.selected } : c))
    );
  }, []);

  const selectedCount = conversations.filter(c => c.selected).length;
  const totalMessages = conversations.filter(c => c.selected).reduce((sum, c) => sum + c.messages.length, 0);

  // ── Render Helpers ────────────────────────────────────────

  const platformLabel: Record<string, string> = {
    claude: 'Claude',
    chatgpt: 'ChatGPT',
    openclaw: 'OpenClaw',
    other: 'Claude Code',
  };

  const platformColor: Record<string, string> = {
    claude: '#d4a574',
    chatgpt: '#74aa9c',
    openclaw: '#e85d4a',
    other: '#8888A0',
  };

  const formatLabel: Record<string, string> = {
    'claude-export': 'Claude.ai Export',
    'chatgpt-export': 'ChatGPT Export',
    'claude-code-jsonl': 'Claude Code Sessions',
    'openclaw-workspace': 'OpenClaw Sessions',
  };

  // Can the user import?
  const canImport = (() => {
    if (extensionDetected) return true; // Extension handles local + cloud
    if (privacyTier === 'own' && !extensionDetected) return false; // Mirror needs extension
    if (accessToken) return true; // Cloud-direct for Analyst without extension
    return false;
  })();

  const importModeText = (() => {
    if (extensionDetected && privacyTier === 'trust') return 'Saving to local vault + cloud sync';
    if (extensionDetected) return 'Saving to local vault';
    if (accessToken && !extensionDetected) return 'Saving to cloud directly';
    return 'Extension required for local-only mode';
  })();

  // ── Render ────────────────────────────────────────────────

  const renderContent = () => {
    if (isAuthenticated === false) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '70vh', gap: '16px',
        }}>
          <div style={{ fontSize: '32px', opacity: 0.4 }}>↓</div>
          <h2 style={{ color: 'var(--text-primary)', fontSize: '20px', fontWeight: 600 }}>
            Sign in to import
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', textAlign: 'center', maxWidth: '360px' }}>
            Sign in to your Kairos account to import conversation history from Claude, ChatGPT, or Claude Code.
          </p>
          <a href="/login" style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            padding: '10px 20px', borderRadius: '8px', background: 'var(--accent)',
            color: 'white', fontSize: '14px', fontWeight: 500, textDecoration: 'none', marginTop: '8px',
          }}>
            Sign in with Google
          </a>
        </div>
      );
    }

    switch (state) {
      case 'idle':
        return renderDropZone();
      case 'parsing':
        return renderParsing();
      case 'analyzing':
        return renderAnalyzing();
      case 'preview':
        return renderPreview();
      case 'importing':
        return renderImporting();
      case 'complete':
        return renderComplete();
      case 'processing':
        return renderProcessing();
      case 'done':
        return renderDone();
      case 'error':
        return renderError();
      default:
        return null;
    }
  };

  const renderDropZone = () => (
    <>
      <div className="page-header">
        <h1 className="page-title">Import History</h1>
        <p className="page-subtitle">
          Upload your conversation exports from Claude.ai, ChatGPT, Claude Code, or OpenClaw
        </p>
      </div>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${isDragging ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: '16px',
          padding: '64px 32px',
          textAlign: 'center',
          cursor: 'pointer',
          transition: 'all 0.2s',
          background: isDragging ? 'var(--accent-dim)' : 'var(--bg-secondary)',
        }}
      >
        <div style={{
          fontSize: '40px', marginBottom: '16px', opacity: isDragging ? 1 : 0.4,
          transition: 'opacity 0.2s',
        }}>
          ↓
        </div>
        <div style={{
          fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px',
        }}>
          {isDragging ? 'Drop files here' : 'Drag & drop export files'}
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' }}>
          or click to browse
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.jsonl,.zip"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

        <div style={{
          display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap',
        }}>
          {[
            { label: 'Claude.ai', ext: '.json / .zip', color: '#d4a574' },
            { label: 'ChatGPT', ext: '.json / .zip', color: '#74aa9c' },
            { label: 'Claude Code', ext: '.jsonl', color: '#8888A0' },
            { label: 'OpenClaw', ext: '.jsonl', color: '#e85d4a' },
          ].map(fmt => (
            <div key={fmt.label} style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
              padding: '4px 10px', borderRadius: '6px',
              background: `${fmt.color}11`, border: `1px solid ${fmt.color}22`,
            }}>
              <span style={{ color: fmt.color, fontWeight: 600 }}>{fmt.label}</span>
              <span>{fmt.ext}</span>
            </div>
          ))}
        </div>
      </div>

      {/* How to export guides */}
      <div style={{ marginTop: '32px' }}>
        <div style={{
          fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '12px',
        }}>
          How to export your conversations
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
          {[
            {
              platform: 'Claude.ai',
              color: '#d4a574',
              steps: 'Settings → Account → Export Data → Download',
            },
            {
              platform: 'ChatGPT',
              color: '#74aa9c',
              steps: 'Settings → Data Controls → Export Data → Download',
            },
            {
              platform: 'Claude Code',
              color: '#8888A0',
              steps: 'Session logs at ~/.claude/projects/*/*.jsonl',
            },
            {
              platform: 'OpenClaw',
              color: '#e85d4a',
              steps: 'Session files at ~/.openclaw/agents/*/sessions/*.jsonl',
            },
          ].map(guide => (
            <div key={guide.platform} style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
              borderRadius: '10px', padding: '14px 16px',
            }}>
              <div style={{
                fontSize: '12px', fontWeight: 600, color: guide.color,
                fontFamily: 'var(--font-mono)', marginBottom: '6px',
              }}>
                {guide.platform}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
                {guide.steps}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );

  const renderParsing = () => (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '60vh', gap: '16px',
    }}>
      <div style={{
        width: '32px', height: '32px',
        border: '3px solid var(--border)', borderTop: '3px solid var(--accent)',
        borderRadius: '50%', animation: 'spin 1s linear infinite',
      }} />
      <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Parsing your export files...</p>
    </div>
  );

  const renderAnalyzing = () => (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '60vh', gap: '16px',
    }}>
      <div style={{
        width: '32px', height: '32px',
        border: '3px solid var(--border)', borderTop: '3px solid var(--accent)',
        borderRadius: '50%', animation: 'spin 1s linear infinite',
      }} />
      <div style={{ textAlign: 'center' }}>
        <p style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600, marginBottom: '6px' }}>
          Analyzing format...
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', fontFamily: 'var(--font-mono)', maxWidth: '360px' }}>
          First time seeing this format — Kairos is learning it.
          Future imports will be instant.
        </p>
      </div>
    </div>
  );

  const renderPreview = () => (
    <>
      <div className="page-header">
        <h1 className="page-title">Preview Import</h1>
        <p className="page-subtitle">
          Found {conversations.length} conversation{conversations.length !== 1 ? 's' : ''} with{' '}
          {conversations.reduce((s, c) => s + c.messages.length, 0)} total messages
          {detectedFormat && ` — ${formatLabel[detectedFormat] || detectedFormat}`}
        </p>
      </div>

      {/* Import mode indicator */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        background: canImport ? 'var(--bg-secondary)' : 'rgba(239, 68, 68, 0.08)',
        border: `1px solid ${canImport ? 'var(--border-subtle)' : 'rgba(239, 68, 68, 0.2)'}`,
        borderRadius: '10px', padding: '12px 16px', marginBottom: '20px',
      }}>
        <span style={{ fontSize: '14px' }}>
          {extensionDetected ? '🔌' : canImport ? '☁' : '⚠'}
        </span>
        <span style={{
          fontSize: '13px', fontFamily: 'var(--font-mono)',
          color: canImport ? 'var(--text-secondary)' : 'var(--danger)',
        }}>
          {importModeText}
        </span>
      </div>

      {/* Selection controls */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '12px',
      }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => toggleAll(true)} style={pillButtonStyle}>Select all</button>
          <button onClick={() => toggleAll(false)} style={pillButtonStyle}>Deselect all</button>
        </div>
        <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
          {selectedCount} selected · {totalMessages} messages
        </span>
      </div>

      {/* Conversation list */}
      <div style={{
        maxHeight: '400px', overflowY: 'auto', borderRadius: '10px',
        border: '1px solid var(--border-subtle)', marginBottom: '20px',
      }}>
        {conversations.map((conv, i) => (
          <div
            key={`${conv.platformConversationId}-${i}`}
            onClick={() => toggleOne(i)}
            style={{
              display: 'grid', gridTemplateColumns: '24px 1fr auto auto',
              alignItems: 'center', gap: '12px',
              padding: '10px 14px', cursor: 'pointer',
              background: conv.selected ? 'var(--bg-secondary)' : 'var(--bg-primary)',
              borderBottom: i < conversations.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              transition: 'background 0.1s',
            }}
          >
            {/* Checkbox */}
            <div style={{
              width: '16px', height: '16px', borderRadius: '4px',
              border: `2px solid ${conv.selected ? 'var(--accent)' : 'var(--border)'}`,
              background: conv.selected ? 'var(--accent)' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}>
              {conv.selected && (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2">
                  <path d="M2 5L4.5 7.5L8 3" />
                </svg>
              )}
            </div>

            {/* Title + source */}
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: '13px', color: 'var(--text-primary)', fontWeight: 500,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {conv.title || 'Untitled conversation'}
              </div>
              <div style={{
                fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
                marginTop: '2px',
              }}>
                {conv.capturedAt?.slice(0, 10)}
              </div>
            </div>

            {/* Platform badge */}
            <span style={{
              fontSize: '10px', fontFamily: 'var(--font-mono)',
              padding: '2px 6px', borderRadius: '4px',
              background: `${platformColor[conv.platform] || '#666'}22`,
              color: platformColor[conv.platform] || '#666',
              whiteSpace: 'nowrap',
            }}>
              {platformLabel[conv.platform] || conv.platform}
            </span>

            {/* Message count */}
            <span style={{
              fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
            }}>
              {conv.messages.length} msg
            </span>
          </div>
        ))}
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div style={{
          background: 'rgba(245, 158, 11, 0.06)', border: '1px solid rgba(245, 158, 11, 0.15)',
          borderRadius: '10px', padding: '12px 16px', marginBottom: '20px',
        }}>
          <div style={{
            fontSize: '12px', fontWeight: 600, color: 'var(--warning)',
            fontFamily: 'var(--font-mono)', marginBottom: '6px',
          }}>
            {warnings.length} warning{warnings.length !== 1 ? 's' : ''}
          </div>
          <div style={{ maxHeight: '120px', overflowY: 'auto' }}>
            {warnings.map((w, i) => (
              <div key={i} style={{
                fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.5',
                fontFamily: 'var(--font-mono)',
              }}>
                {w}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button
          onClick={startImport}
          disabled={selectedCount === 0 || !canImport}
          style={{
            background: selectedCount > 0 && canImport ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: selectedCount > 0 && canImport ? '#fff' : 'var(--text-muted)',
            border: 'none', padding: '10px 24px', borderRadius: '8px',
            fontSize: '14px', fontWeight: 600, cursor: selectedCount > 0 && canImport ? 'pointer' : 'not-allowed',
            transition: 'all 0.15s',
          }}
        >
          Import {selectedCount} conversation{selectedCount !== 1 ? 's' : ''}
        </button>
        <button
          onClick={() => {
            setState('idle');
            setConversations([]);
            setWarnings([]);
            setDetectedFormat(null);
          }}
          style={{
            ...pillButtonStyle,
            padding: '10px 20px',
            fontSize: '13px',
          }}
        >
          Start over
        </button>
      </div>
    </>
  );

  const renderImporting = () => {
    const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '60vh', gap: '24px',
      }}>
        <div style={{
          width: '32px', height: '32px',
          border: '3px solid var(--border)', borderTop: '3px solid var(--accent)',
          borderRadius: '50%', animation: 'spin 1s linear infinite',
        }} />

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
            Importing conversations...
          </div>
          <div style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            {progress.completed} of {progress.total}
          </div>
        </div>

        {/* Progress bar */}
        <div style={{
          width: '320px', height: '6px', borderRadius: '3px',
          background: 'var(--bg-tertiary)', overflow: 'hidden',
        }}>
          <div style={{
            width: `${pct}%`, height: '100%', borderRadius: '3px',
            background: 'var(--accent)', transition: 'width 0.3s ease',
          }} />
        </div>
      </div>
    );
  };

  const renderComplete = () => (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '60vh', gap: '20px',
    }}>
      <div style={{
        width: '56px', height: '56px', borderRadius: '50%',
        background: 'rgba(34, 197, 94, 0.12)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17L4 12" />
        </svg>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
          {progress.completed} conversation{progress.completed !== 1 ? 's' : ''} imported
        </div>
        <div style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
          Starting analysis...
        </div>
      </div>
    </div>
  );

  const renderProcessing = () => (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '60vh', gap: '24px',
    }}>
      <div style={{
        width: '56px', height: '56px', borderRadius: '50%',
        background: 'rgba(99, 102, 241, 0.12)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        animation: 'pulse 2s ease-in-out infinite',
      }}>
        <div style={{ fontSize: '24px' }}>◉</div>
      </div>

      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
          Analyzing your conversations
        </div>
        <div style={{ fontSize: '14px', color: 'var(--text-muted)', maxWidth: '400px', lineHeight: '1.6' }}>
          Extracting ideas, detecting drift patterns, classifying engagement, and building your knowledge graph.
          This may take a few minutes.
        </div>
      </div>

      <div style={{ width: '100%', maxWidth: '400px' }}>
        {pipelineSteps.map((step, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: '12px',
            padding: '10px 0',
            borderBottom: i < pipelineSteps.length - 1 ? '1px solid var(--border-subtle)' : 'none',
          }}>
            <div style={{ fontSize: '14px', width: '20px', textAlign: 'center' }}>
              {step.status === 'running' ? (
                <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>◐</span>
              ) : step.status === 'complete' ? (
                <span style={{ color: 'var(--success)' }}>✓</span>
              ) : step.status === 'partial' ? (
                <span style={{ color: '#F59E0B' }}>◑</span>
              ) : step.status === 'skipped' ? (
                <span style={{ color: 'var(--text-muted)' }}>—</span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>○</span>
              )}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: '13px',
                color: step.status === 'running' ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: step.status === 'running' ? 600 : 400,
              }}>
                {step.name}
              </div>
              {step.count != null && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {step.count} processed{step.errors ? ` (${step.errors} errors)` : ''}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );

  const renderDone = () => (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '60vh', gap: '20px',
    }}>
      <div style={{
        width: '56px', height: '56px', borderRadius: '50%',
        background: pipelineError && !pipelineResult ? 'rgba(245, 158, 11, 0.12)' : 'rgba(34, 197, 94, 0.12)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {pipelineError && !pipelineResult ? (
          <span style={{ fontSize: '24px' }}>◑</span>
        ) : (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17L4 12" />
          </svg>
        )}
      </div>

      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
          {pipelineError && !pipelineResult ? 'Import complete' : 'Your thinking patterns are ready'}
        </div>
        <div style={{ fontSize: '14px', color: 'var(--text-muted)', maxWidth: '400px', lineHeight: '1.6' }}>
          {pipelineError && !pipelineResult
            ? pipelineError
            : `${progress.completed} conversations analyzed. Your dashboard is ready.`
          }
        </div>
      </div>

      {/* Show step results */}
      {pipelineSteps.length > 0 && (
        <div style={{ width: '100%', maxWidth: '400px' }}>
          {pipelineSteps.map((step, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '6px 0', fontSize: '13px',
            }}>
              <span style={{ width: '20px', textAlign: 'center' }}>
                {step.status === 'complete' ? (
                  <span style={{ color: 'var(--success)' }}>✓</span>
                ) : step.status === 'skipped' ? (
                  <span style={{ color: 'var(--text-muted)' }}>—</span>
                ) : (
                  <span style={{ color: '#F59E0B' }}>◑</span>
                )}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {step.name}{step.count != null ? `: ${step.count}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
        <a href="/dashboard" style={{
          display: 'inline-flex', alignItems: 'center', gap: '8px',
          padding: '10px 24px', borderRadius: '8px', background: 'var(--accent)',
          color: 'white', fontSize: '14px', fontWeight: 600, textDecoration: 'none',
        }}>
          View Your Patterns
        </a>
        <button
          onClick={() => {
            setState('idle');
            setConversations([]);
            setWarnings([]);
            setProgress({ total: 0, completed: 0, errors: [] });
            setDetectedFormat(null);
            setPipelineSteps([]);
            setPipelineError(null);
            setPipelineResult(null);
          }}
          style={{
            ...pillButtonStyle,
            padding: '10px 20px',
            fontSize: '13px',
          }}
>
          Import more
        </button>
      </div>
    </div>
  );

  const renderError = () => (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '60vh', gap: '16px',
    }}>
      <div style={{ fontSize: '32px' }}>⚠</div>
      <div style={{ fontSize: '16px', fontWeight: 600, color: '#f87171' }}>
        Could not parse file
      </div>
      <p style={{
        color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center',
        maxWidth: '420px', lineHeight: '1.6',
      }}>
        {errorMessage}
      </p>
      <button
        onClick={() => {
          setState('idle');
          setErrorMessage(null);
        }}
        style={{
          background: 'var(--accent)', color: '#fff', border: 'none',
          padding: '10px 24px', borderRadius: '8px', fontSize: '14px',
          fontWeight: 600, cursor: 'pointer', marginTop: '8px',
        }}
      >
        Try again
      </button>
    </div>
  );

  // ── Page Layout ───────────────────────────────────────────

  return (
    <div className="dashboard-layout">
      <Sidebar activePage="import" />
      <main className="main-content">
        {renderContent()}
      </main>
    </div>
  );
}

// ============================================================
// SHARED STYLES
// ============================================================

const pillButtonStyle: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
  padding: '6px 14px',
  borderRadius: '6px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  transition: 'all 0.15s',
};

// ============================================================
// Analyze Pipeline Button (triggers server-side analysis)
// ============================================================

function AnalyzePipelineButton({ getSession }: { getSession: () => Promise<any> }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const session = await getSession();
      if (!session?.access_token) {
        setError('Not signed in');
        return;
      }

      const res = await fetch('/api/pipeline/trigger', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Pipeline failed');
        return;
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pipeline failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{
      marginTop: '16px',
      padding: '16px',
      background: 'var(--bg-secondary)',
      borderRadius: '10px',
      border: '1px solid var(--border-subtle)',
      maxWidth: '480px',
      width: '100%',
    }}>
      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
        Analyze Conversations
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: '1.5' }}>
        Extract ideas, detect drift, classify engagement patterns, and build your knowledge graph.
        Uses your API keys (configured in Settings).
      </div>

      {!result && (
        <button
          onClick={handleAnalyze}
          disabled={running}
          style={{
            padding: '10px 24px',
            borderRadius: '8px',
            border: 'none',
            background: running ? 'var(--bg-tertiary)' : '#6366F1',
            color: running ? 'var(--text-muted)' : '#fff',
            fontSize: '14px',
            fontWeight: 600,
            cursor: running ? 'not-allowed' : 'pointer',
          }}
        >
          {running ? 'Analyzing... (this may take a few minutes)' : 'Run Analysis Pipeline'}
        </button>
      )}

      {error && (
        <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '8px' }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: '8px' }}>
          <div style={{ fontSize: '13px', color: '#4ade80', marginBottom: '8px' }}>
            ✓ Pipeline complete
          </div>
          {result.steps?.map((step: any, i: number) => (
            <div key={i} style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
              {step.name}: {step.count} processed{step.errors > 0 ? ` (${step.errors} errors)` : ''}
            </div>
          ))}
          {result.errors?.length > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '8px' }}>
              {result.errors.slice(0, 3).map((e: string, i: number) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
          <a href="/" style={{
            display: 'inline-block', marginTop: '12px', padding: '8px 16px',
            borderRadius: '6px', background: 'var(--accent)', color: '#fff',
            fontSize: '13px', fontWeight: 500, textDecoration: 'none',
          }}>
            View Dashboard →
          </a>
        </div>
      )}
    </div>
  );
}
