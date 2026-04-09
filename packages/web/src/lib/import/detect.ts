/**
 * Kairos Import — Format Detection & ZIP Extraction
 *
 * Auto-detects file format from content and extracts files from ZIP archives.
 */

import JSZip from 'jszip';
import type { ImportFormat } from './parsers';

/**
 * Detect the import format from file content.
 * Checks structure/keys rather than relying solely on file extension.
 */
export function detectFormat(content: string, fileName?: string): ImportFormat {
  // Try parsing as JSON first (single valid JSON object/array)
  try {
    const parsed = JSON.parse(content);

    // ChatGPT: array of objects with `mapping` and `current_node`
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0];
      if (first && typeof first === 'object' && 'mapping' in first && 'current_node' in first) {
        return 'chatgpt-export';
      }
    }

    // Claude.ai: object with `meta` and `chats`
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if ('meta' in parsed && 'chats' in parsed) {
        return 'claude-export';
      }
    }

    // Claude.ai: array of objects with `meta` and `chats` (bulk export)
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0];
      if (first && typeof first === 'object' && 'meta' in first && 'chats' in first) {
        return 'claude-export';
      }
    }
  } catch {
    // Not valid JSON — check if it's JSONL
    const firstLine = content.split('\n')[0]?.trim();
    if (firstLine) {
      try {
        const firstObj = JSON.parse(firstLine);
        if (firstObj && typeof firstObj === 'object') {
          // Claude Code JSONL has `sessionId` and `type` fields
          if ('sessionId' in firstObj && 'type' in firstObj) {
            return 'claude-code-jsonl';
          }
          // OpenClaw JSONL has `role` and `content` fields (standard LLM message format)
          if ('role' in firstObj && 'content' in firstObj) {
            return 'openclaw-workspace';
          }
        }
      } catch {
        // Not JSONL either
      }
    }
  }

  return 'unknown';
}

/**
 * Extract all .json and .jsonl files from a ZIP archive.
 * Returns file contents as strings with their names.
 */
export async function extractFromZip(
  file: File
): Promise<Array<{ name: string; content: string }>> {
  const zip = await JSZip.loadAsync(file);
  const results: Array<{ name: string; content: string }> = [];

  const entries = Object.entries(zip.files);

  for (const [path, zipEntry] of entries) {
    // Skip directories and hidden files
    if (zipEntry.dir) continue;
    if (path.startsWith('__MACOSX')) continue;
    if (path.startsWith('.')) continue;

    // Only extract JSON and JSONL files
    const lowerPath = path.toLowerCase();
    if (!lowerPath.endsWith('.json') && !lowerPath.endsWith('.jsonl')) continue;

    const content = await zipEntry.async('string');
    const name = path.split('/').pop() || path;
    results.push({ name, content });
  }

  return results;
}

/**
 * Check if a File is a ZIP archive by checking magic bytes or extension.
 */
export function isZipFile(file: File): boolean {
  return (
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    file.name.toLowerCase().endsWith('.zip')
  );
}
