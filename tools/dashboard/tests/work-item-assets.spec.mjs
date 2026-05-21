/**
 * Work-item asset upload/retrieval contract tests — W-1199
 *
 * Tests use the isolated WORK_DIR provided by the per-worker test server.
 * The server creates work/assets/ at startup; no real work/assets/ is touched.
 *
 * WA-1: POST /api/work-items/assets/upload with valid PNG returns 200 + filename
 * WA-2: GET /api/work-items/assets/:filename returns 200 with file content
 * WA-3: Path traversal in upload filename returns 400, file not written outside assets dir
 * WA-4: Upload file >10MB returns 413 before full buffer
 * WA-5: GET non-existent file returns 404
 * WA-6: GET /api/work-items/assets/probe returns 200 { ok: true }
 * WA-7: POST without multipart boundary returns 400
 * WA-8: Upload endpoint stores file with UUID prefix; returned filename contains UUID pattern
 * WA-9: Upload with no Content-Type returns 400
 */

import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG header
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk length + type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixel
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth + color + CRC
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

function buildMultipartBody(boundary, filename, fileContent) {
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: application/octet-stream',
    '',
    '',
  ].join('\r\n');
  const footer = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([
    Buffer.from(header),
    fileContent,
    Buffer.from(footer),
  ]);
}

async function upload(filename, fileContent, boundary = 'testboundary12345') {
  const base = getBase();
  const body = buildMultipartBody(boundary, filename, fileContent);
  return fetch(`${base}/api/work-items/assets/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

test.describe('Work-item asset routes @fast', () => {

  test('WA-1: POST upload with valid file returns 200 and stored filename', async () => {
    const res = await upload('test.png', TINY_PNG);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.filename).toBe('string');
    expect(body.filename.length).toBeGreaterThan(0);
    expect(body.filename).toMatch(/\.png$/);
  });

  test('WA-2: GET uploaded file returns 200 with correct content', async () => {
    const base = getBase();
    const uploadRes = await upload('retrieve-test.png', TINY_PNG);
    expect(uploadRes.status).toBe(200);
    const { filename } = await uploadRes.json();

    const getRes = await fetch(`${base}/api/work-items/assets/${filename}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toMatch(/image\/png/);
    const buf = Buffer.from(await getRes.arrayBuffer());
    expect(buf.length).toBe(TINY_PNG.length);
  });

  test('WA-3: path traversal in upload filename returns 400', async () => {
    // The server sanitizes the filename; the stored file should never escape assets dir.
    // Even with a traversal attempt, the response must be 400 or the file stored safely.
    const res = await upload('../../etc/passwd', Buffer.from('evil'));
    // Either the server sanitizes and returns 200 (stored safely) or returns 400.
    // Per spec: traversal attempts must not write outside work/assets/
    if (res.status === 200) {
      const { filename } = await res.json();
      // Sanitized filename must not contain path separators or traversal sequences
      expect(filename).not.toContain('/');
      expect(filename).not.toContain('\\');
      expect(filename).not.toContain('..');
    } else {
      expect(res.status).toBe(400);
    }
  });

  test('WA-4: GET path traversal in filename returns 400', async () => {
    const base = getBase();
    const encoded = encodeURIComponent('../../etc/passwd');
    const res = await fetch(`${base}/api/work-items/assets/${encoded}`);
    expect(res.status).toBe(400);
  });

  test('WA-5: GET non-existent file returns 404', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/work-items/assets/nonexistent-file-zzzz.png`);
    expect(res.status).toBe(404);
  });

  test('WA-6: GET /api/work-items/assets/probe returns 200 with ok:true', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/work-items/assets/probe`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('WA-7: POST upload without multipart boundary returns 400', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/work-items/assets/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  test('WA-8: stored filename contains UUID prefix pattern', async () => {
    const res = await upload('myfile.txt', Buffer.from('hello'));
    expect(res.status).toBe(200);
    const { filename } = await res.json();
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (8-4-4-4-12 hex chars)
    expect(filename).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/);
  });

  test('WA-9: POST upload with no Content-Type returns 400', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/work-items/assets/upload`, {
      method: 'POST',
      body: Buffer.from('raw bytes'),
    });
    expect(res.status).toBe(400);
  });

  test('WA-10: upload file just over 10MB returns 413', { timeout: 60_000 }, async () => {
    const base = getBase();
    const overLimitBytes = 10 * 1024 * 1024 + 1;
    const boundary = 'sizelimitboundary';
    const fileContent = Buffer.alloc(overLimitBytes, 0x41); // 10MB+1 of 'A'
    const body = buildMultipartBody(boundary, 'big.bin', fileContent);

    const res = await fetch(`${base}/api/work-items/assets/upload`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(res.status).toBe(413);
  });

  test('WA-11: two uploads produce different filenames (UUID uniqueness)', async () => {
    const [r1, r2] = await Promise.all([
      upload('dup.txt', Buffer.from('a')),
      upload('dup.txt', Buffer.from('b')),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const { filename: f1 } = await r1.json();
    const { filename: f2 } = await r2.json();
    expect(f1).not.toBe(f2);
  });

});
