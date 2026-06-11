import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Orphan policy: asset files are NOT deleted when the parent work item is deleted.
// The link between a work item and its assets exists only in the description text
// (Markdown image/link syntax). If the parent item is deleted, the asset file
// remains on disk. Disk quota management is the operator's responsibility —
// periodically audit work/assets/ for files no longer referenced by any work item.

export default function workItemAssetsRoutes(deps) {
  const { json, err, WORK } = deps;
  const WORK_ASSETS_DIR = join(WORK, 'assets');

  return [
    [/^\/api\/work-items\/assets\/probe$/, 'GET', async (_m, _req, res) => {
      json(res, { ok: true });
    }],

    [/^\/api\/work-items\/assets\/upload$/, 'POST', async (_m, req, res) => {
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=("?)([^";]+)\1/);
      if (!boundaryMatch) return err(res, 'missing boundary', 400);
      const boundary = boundaryMatch[2];

      const body = await readBodyWithSizeLimit(req, MAX_FILE_BYTES);
      if (body === null) return err(res, 'file too large', 413);

      const parsed = parseMultipartFile(body, boundary);
      if (!parsed) return err(res, 'no file found in upload', 400);

      const { filename: rawFilename, data } = parsed;
      const safeName = sanitizeFilename(rawFilename);
      const storedName = `${randomUUID()}-${safeName}`;

      let resolvedDir;
      try {
        resolvedDir = await realpath(WORK_ASSETS_DIR);
      } catch {
        return err(res, 'storage not ready', 500);
      }

      const targetPath = resolve(resolvedDir, storedName);
      if (!targetPath.startsWith(resolvedDir + '/') && targetPath !== resolvedDir) {
        return err(res, 'forbidden', 400);
      }

      await writeFile(targetPath, data);
      json(res, { filename: storedName });
    }],

    [/^\/api\/work-items\/assets\/([^/]+)$/, 'GET', async (m, _req, res) => {
      const requestedFilename = decodeURIComponent(m[1]);

      // Reject path traversal attempts before filesystem access.
      if (requestedFilename.includes('/') || requestedFilename.includes('\\') || requestedFilename.includes('..')) {
        return err(res, 'forbidden', 400);
      }

      let resolvedPath;
      try {
        resolvedPath = await realpath(join(WORK_ASSETS_DIR, requestedFilename));
        const resolvedDir = await realpath(WORK_ASSETS_DIR);
        if (!resolvedPath.startsWith(resolvedDir + '/') && resolvedPath !== resolvedDir) {
          return err(res, 'forbidden', 400);
        }
      } catch {
        return err(res, 'not found', 404);
      }

      let content;
      try {
        content = await readFile(resolvedPath);
      } catch {
        return err(res, 'not found', 404);
      }

      const ext = requestedFilename.split('.').pop()?.toLowerCase() ?? '';
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
      res.end(content);
    }],
  ];
}

async function readBodyWithSizeLimit(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipartFile(body, boundary) {
  const startMarker = `--${boundary}\r\n`;
  const startIdx = body.indexOf(startMarker);
  if (startIdx < 0) return null;

  const headersStart = startIdx + startMarker.length;
  const headersEnd = body.indexOf('\r\n\r\n', headersStart);
  if (headersEnd < 0) return null;

  const headers = body.slice(headersStart, headersEnd).toString('ascii');
  const dataStart = headersEnd + 4;

  const nextBoundary = `\r\n--${boundary}`;
  const nextIdx = body.indexOf(nextBoundary, dataStart);
  const data = nextIdx >= 0 ? body.slice(dataStart, nextIdx) : body.slice(dataStart);

  const filenameMatch = headers.match(/filename="([^"]+)"/i);
  if (!filenameMatch) return null;

  return { filename: filenameMatch[1], data };
}

function sanitizeFilename(raw) {
  const stripped = raw.replace(/[/\\]/g, '').replace(/\.\./g, '');
  const safe = stripped.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'file';
}

const MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};
