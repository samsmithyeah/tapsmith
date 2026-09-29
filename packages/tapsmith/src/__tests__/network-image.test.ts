import { describe, it, expect } from 'vitest';
import { contentTypeCharset, headerValue, imagePlan, sniffImageType, svgRasterSize, xmlEncoding } from '../trace-viewer/components/network-image.js';
import { bodyPlaceholder, isBodyPlaceholder } from '../trace/body-placeholder.js';

// Complete images in outline: each carries its format's signature and end marker.
// PNG: signature, an IHDR chunk (length, type, 13 data bytes, CRC), IEND.
const PNG_IEND = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde,
  ...PNG_IEND,
]);
// JPEG: SOI, an APP0 segment, a scan header (SOS), entropy-coded data with a
// stuffed 0xFF00 and a restart marker, EOI.
const JPEG = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, 0, 4, 0x4a, 0x46,
  0xff, 0xda, 0, 3, 1,
  0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56,
  0xff, 0xd9,
]);
// GIF: header + logical screen descriptor (no colour table), one image
// descriptor with its LZW data in one sub-block, the trailer.
const GIF = new Uint8Array([
  ...new TextEncoder().encode('GIF89a'), 1, 0, 1, 0, 0, 0, 0,
  0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0,
  0x3b,
]);
// ICO: ICONDIR (1 image), its entry (4 bytes at offset 22), the data.
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0, 9, 9, 9, 9]);
// BMP: file header whose bfSize (bytes 2–5) is the file's length.
const BMP = new Uint8Array([0x42, 0x4d, 10, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 6, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const GZIP = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]);
const JSON_BODY = new TextEncoder().encode('{"ok":true}');
const MiB = 1024 * 1024;

// Bodies here are what the runner stores: already dechunked and decompressed,
// with the headers left as they crossed the wire.
function plan(o: Partial<Parameters<typeof imagePlan>[0]> & { body: Uint8Array }) {
  return imagePlan({
    contentType: '',
    headers: {},
    declaredBytes: o.body.length,
    inFlight: false,
    direction: 'response',
    status: 200,
    ...o,
  });
}

describe('sniffImageType', () => {
  it('recognises PNG, JPEG, GIF and WebP by their magic bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('rejects text, compressed bytes, and a RIFF container that is not WebP', () => {
    expect(sniffImageType(JSON_BODY)).toBeNull();
    expect(sniffImageType(GZIP)).toBeNull();
    const wav = WEBP.slice();
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // RIFF....WAVE
    expect(sniffImageType(wav)).toBeNull();
  });

  it('does not read past a body shorter than the signature', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('isBodyPlaceholder', () => {
  it('recognises both of UI mode\'s markers and nothing else', () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(isBodyPlaceholder(bytes(bodyPlaceholder(6_500_000, 'stream live', 'request')))).toBe(true);
    expect(isBodyPlaceholder(bytes(bodyPlaceholder(2_500_000, 'display inline')))).toBe(true);
    expect(isBodyPlaceholder(bytes('[body too large to display inline — 3.0 MB; open the trace archive to inspect] trailing'))).toBe(false);
    expect(isBodyPlaceholder(bytes('["a", "b"]'))).toBe(false);
    expect(isBodyPlaceholder(new Uint8Array())).toBe(false);
  });
});

describe('svgRasterSize', () => {
  it('keeps a size the SVG declares', () => {
    expect(svgRasterSize('40', '20px', '0 0 1 1')).toEqual({ width: 40, height: 20, declared: true });
  });

  it('sizes a viewBox-only SVG from its aspect ratio at the default width', () => {
    expect(svgRasterSize(null, null, '0 0 24 12')).toEqual({ width: 300, height: 150, declared: false });
    expect(svgRasterSize(null, null, '0,0,10,20')).toEqual({ width: 300, height: 600, declared: false });
  });

  it('completes one declared dimension from the viewBox', () => {
    expect(svgRasterSize('64', null, '0 0 32 16')).toEqual({ width: 64, height: 32, declared: false });
    expect(svgRasterSize(null, '10', '0 0 32 16')).toEqual({ width: 20, height: 10, declared: false });
  });

  it('converts absolute units, so tool-exported sizes are kept', () => {
    // Inkscape's default page, Graphviz's points, and an exponent number.
    const a4 = svgRasterSize('210mm', '297mm', '0 0 210 297');
    expect(a4.declared).toBe(true);
    expect(a4.width).toBeCloseTo(793.7, 1);
    expect(a4.height).toBeCloseTo(1122.5, 1);
    const graphviz = svgRasterSize('62pt', '116pt', null);
    expect(graphviz.declared).toBe(true);
    expect(graphviz.width).toBeCloseTo(82.667, 2);
    expect(graphviz.height).toBeCloseTo(154.667, 2);
    expect(svgRasterSize('1e3', '10', null)).toEqual({ width: 1000, height: 10, declared: true });
    expect(svgRasterSize('1in', '2.54cm', null)).toEqual({ width: 96, height: 96, declared: true });
  });

  it('rejects a space between number and unit, as CSS does', () => {
    expect(svgRasterSize('24 px', '24 px', '0 0 48 24')).toEqual({ width: 300, height: 150, declared: false });
  });

  it('treats relative units and a bad viewBox as absent', () => {
    expect(svgRasterSize('100%', '2em', null)).toEqual({ width: 300, height: 150, declared: false });
    expect(svgRasterSize(null, null, '0 0 0 10')).toEqual({ width: 300, height: 150, declared: false });
  });
});

describe('xmlEncoding', () => {
  const latin1 = (s: string) => new Uint8Array([...s].map(c => c.charCodeAt(0)));
  it('reads the XML declaration, else a byte-order mark, else UTF-8', () => {
    expect(xmlEncoding(latin1(`<?xml version="1.0" encoding="ISO-8859-1"?><svg/>`))).toBe('iso-8859-1');
    expect(xmlEncoding(latin1(`  <?xml version='1.0' encoding='windows-1252' standalone="no"?>`))).toBe('windows-1252');
    expect(xmlEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]))).toBe('utf-8');
    expect(xmlEncoding(new Uint8Array([0xff, 0xfe, 0x3c, 0]))).toBe('utf-16le');
    expect(xmlEncoding(latin1('<svg/>'))).toBe('utf-8');
    // "encoding" outside the declaration is not the declaration's.
    expect(xmlEncoding(latin1('<svg><text>encoding="latin1"</text></svg>'))).toBe('utf-8');
  });

  it('ignores a UTF-16 label on bytes that are plainly not UTF-16 (a known UTF-8 mislabel)', () => {
    expect(xmlEncoding(latin1('<?xml version="1.0" encoding="UTF-16"?><svg/>'))).toBe('utf-8');
    expect(xmlEncoding(latin1('<svg/>'), 'utf-16')).toBe('utf-8');
    // Real BOM-less UTF-16: ASCII characters carry a zero byte.
    expect(xmlEncoding(new Uint8Array([0x3c, 0, 0x73, 0]), 'utf-16')).toBe('utf-16le');
    expect(xmlEncoding(new Uint8Array([0, 0x3c, 0, 0x73]), 'utf-16')).toBe('utf-16be');
  });

  it('skips an HTTP charset the decoder does not know, for the declaration', () => {
    expect(xmlEncoding(latin1('<?xml version="1.0" encoding="windows-1252"?><svg/>'), 'binary')).toBe('windows-1252');
    expect(xmlEncoding(latin1('<svg/>'), 'binary')).toBe('utf-8');
  });

  it('lets the HTTP charset outrank the declaration, and a BOM outrank both (RFC 7303)', () => {
    expect(xmlEncoding(latin1('<?xml version="1.0" encoding="UTF-8"?><svg/>'), 'windows-1252')).toBe('windows-1252');
    expect(xmlEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]), 'windows-1252')).toBe('utf-8');
  });
});

describe('contentTypeCharset', () => {
  it('reads the charset parameter, quoted or not', () => {
    expect(contentTypeCharset('image/svg+xml; charset=Windows-1252')).toBe('windows-1252');
    expect(contentTypeCharset('image/svg+xml;charset="utf-8"')).toBe('utf-8');
    expect(contentTypeCharset('image/svg+xml')).toBeUndefined();
  });
});

describe('headerValue', () => {
  it('matches header names case-insensitively', () => {
    expect(headerValue({ 'Content-Encoding': 'gzip' }, 'content-encoding')).toBe('gzip');
    expect(headerValue({}, 'content-encoding')).toBeUndefined();
    expect(headerValue(undefined, 'content-type')).toBeUndefined();
  });
});

describe('imagePlan', () => {
  it('previews a body declared as a renderable image type', () => {
    expect(plan({ body: PNG, contentType: 'image/png' })).toEqual({ kind: 'preview', mimeType: 'image/png' });
    expect(plan({ body: PNG, contentType: 'IMAGE/PNG; charset=binary' })).toEqual({ kind: 'preview', mimeType: 'image/png' });
    expect(plan({ body: JPEG, contentType: 'image/jpg' })).toEqual({ kind: 'preview', mimeType: 'image/jpeg' });
    expect(plan({ body: new TextEncoder().encode('<svg/>'), contentType: 'image/svg+xml' }))
      .toEqual({ kind: 'preview', mimeType: 'image/svg+xml' });
  });

  it('previews an image served with a generic or missing content type, by sniffing', () => {
    expect(plan({ body: PNG, contentType: 'application/octet-stream' })).toEqual({ kind: 'preview', mimeType: 'image/png' });
    expect(plan({ body: WEBP, contentType: '' })).toEqual({ kind: 'preview', mimeType: 'image/webp' });
  });

  it('sniffs only a generic or missing type, believing a specific non-image one', () => {
    // A protobuf body can begin with JPEG's three-byte signature.
    expect(plan({ body: JPEG, contentType: 'application/x-protobuf' })).toEqual({ kind: 'none' });
    expect(plan({ body: PNG, contentType: 'text/plain' })).toEqual({ kind: 'none' });
    expect(plan({ body: PNG, contentType: 'binary/octet-stream' })).toEqual({ kind: 'preview', mimeType: 'image/png' });
  });

  it('previews a raster image served as SVG as the raster it is', () => {
    // A PNG fallback served for a .svg URL would fail in the SVG path.
    expect(plan({ body: PNG, contentType: 'image/svg+xml' })).toEqual({ kind: 'preview', mimeType: 'image/png' });
    expect(plan({ body: new TextEncoder().encode('<svg/>'), contentType: 'image/svg+xml' }))
      .toEqual({ kind: 'preview', mimeType: 'image/svg+xml' });
  });

  it('accepts common aliases of renderable types', () => {
    const bmp = new Uint8Array([0x42, 0x4d, 1, 2]);
    expect(plan({ body: bmp, contentType: 'image/x-ms-bmp' })).toEqual({ kind: 'preview', mimeType: 'image/bmp' });
    expect(plan({ body: new Uint8Array([0, 0, 1, 0]), contentType: 'image/ico' })).toEqual({ kind: 'preview', mimeType: 'image/x-icon' });
    expect(plan({ body: PNG, contentType: 'image/x-png' })).toEqual({ kind: 'preview', mimeType: 'image/png' });
  });

  it('leaves non-image bodies alone', () => {
    expect(plan({ body: JSON_BODY, contentType: 'application/json' })).toEqual({ kind: 'none' });
    expect(plan({ body: GZIP, contentType: 'application/octet-stream' })).toEqual({ kind: 'none' });
  });

  it('reports an image type the browser cannot render instead of attempting it', () => {
    expect(plan({ body: new Uint8Array([0x49, 0x49, 0x2a, 0]), contentType: 'image/tiff' }))
      .toEqual({ kind: 'unavailable', mimeType: 'image/tiff', reason: { code: 'unsupported-type' } });
  });

  describe('compressed and chunked bodies (already decoded by the runner)', () => {
    it('previews them, whatever the encoding header says', () => {
      for (const encoding of ['gzip', 'deflate', 'br', 'zstd', 'gzip, br']) {
        expect(plan({ body: PNG, contentType: 'image/png', headers: { 'Content-Encoding': encoding } }))
          .toEqual({ kind: 'preview', mimeType: 'image/png' });
      }
    });

    it('still sniffs a generically typed compressed image', () => {
      expect(plan({ body: PNG, contentType: 'application/octet-stream', headers: { 'content-encoding': 'gzip' } }))
        .toEqual({ kind: 'preview', mimeType: 'image/png' });
    });

    it('does not mistake a wire size larger than the decoded body for truncation', () => {
      // Gzip grows already-compressed PNG; chunk framing adds bytes too.
      expect(plan({ body: PNG, contentType: 'image/png', declaredBytes: PNG.length + 30, headers: { 'content-encoding': 'gzip' } }))
        .toEqual({ kind: 'preview', mimeType: 'image/png' });
      expect(plan({ body: PNG, contentType: 'image/png', declaredBytes: PNG.length + 20, headers: { 'Transfer-Encoding': 'chunked' } }))
        .toEqual({ kind: 'preview', mimeType: 'image/png' });
    });

    it('reports truncation when the wire size is past the capture limit', () => {
      expect(plan({ body: PNG, contentType: 'image/png', declaredBytes: 2 * MiB, headers: { 'transfer-encoding': 'chunked' } }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/png', reason: { code: 'truncated', captured: MiB, declared: 2 * MiB } });
    });

    it('reports a compressed transfer that stopped short of its Content-Length', () => {
      // Not chunked, so Content-Length and the recorded size are both wire bytes.
      expect(plan({ body: PNG, contentType: 'image/png', declaredBytes: 25_000, headers: { 'content-encoding': 'br', 'content-length': '40000' } }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/png', reason: { code: 'truncated', captured: 25_000, declared: 40_000 } });
      // The `request` fixture records the decoded length, which equals the body.
      expect(plan({ body: PNG, contentType: 'image/png', headers: { 'content-encoding': 'gzip', 'content-length': '40000' } }))
        .toEqual({ kind: 'preview', mimeType: 'image/png' });
    });

    it('reports chunk framing the runner left in place (last chunk cut short)', () => {
      const framed = new TextEncoder().encode('1000\r\n\u0089PNG\r\n');
      expect(plan({ body: framed, contentType: 'image/png', declaredBytes: framed.length, headers: { 'Transfer-Encoding': 'chunked' } }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/png', reason: { code: 'incomplete' } });
      // Padded size lines, which the runner's dechunker also accepts.
      const padded = new TextEncoder().encode('1000 ;ext=1\r\n\u0089PNG');
      expect(plan({ body: padded, contentType: 'image/png', declaredBytes: padded.length, headers: { 'Transfer-Encoding': 'chunked' } }))
        .toMatchObject({ reason: { code: 'incomplete' } });
      // "8000\r\n" is also a valid zlib header; the framing is the true story.
      const deflateFramed = new TextEncoder().encode('8000\r\nxyz');
      expect(plan({ body: deflateFramed, contentType: 'image/png', declaredBytes: deflateFramed.length,
        headers: { 'Transfer-Encoding': 'chunked', 'Content-Encoding': 'deflate' } }))
        .toMatchObject({ reason: { code: 'incomplete' } });
    });

    it('reports a gzip body the runner could not decompress', () => {
      expect(plan({ body: GZIP, contentType: 'image/png', headers: { 'content-encoding': 'gzip' } }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/png', reason: { code: 'undecoded', encoding: 'gzip' } });
    });

    it('reports a coding the runner never decodes, unless the bytes are already the image', () => {
      const zstdFrame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0]);
      expect(plan({ body: zstdFrame, contentType: 'image/svg+xml', headers: { 'Content-Encoding': 'zstd' } }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/svg+xml', reason: { code: 'undecoded', encoding: 'zstd' } });
      expect(plan({ body: zstdFrame, contentType: 'image/png', headers: { 'content-encoding': 'gzip, br' } }))
        .toMatchObject({ reason: { code: 'undecoded', encoding: 'gzip, br' } });
      // Decoded by some other producer (the `request` fixture's fetch).
      expect(plan({ body: new TextEncoder().encode('﻿  <svg/>'), contentType: 'image/svg+xml', headers: { 'content-encoding': 'zstd' } }))
        .toEqual({ kind: 'preview', mimeType: 'image/svg+xml' });
    });
  });

  describe('truncation of an unframed body', () => {
    it('refuses a body shorter than its recorded size', () => {
      expect(plan({ body: PNG, contentType: 'image/png', declaredBytes: 2 * MiB }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/png', reason: { code: 'truncated', captured: PNG.length, declared: 2 * MiB } });
    });

    it('refuses a body shorter than its Content-Length, even when the recorded size matches', () => {
      // The plain-HTTP proxy records only the bytes it read when an upstream
      // read stalls, so the recorded size alone can't show the gap.
      expect(plan({ body: PNG, contentType: 'image/png', headers: { 'Content-Length': '5000' } }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/png', reason: { code: 'truncated', captured: PNG.length, declared: 5000 } });
      expect(plan({ body: PNG, contentType: 'image/png', headers: { 'content-length': String(PNG.length) } }))
        .toEqual({ kind: 'preview', mimeType: 'image/png' });
      expect(plan({ body: PNG, contentType: 'image/png', headers: { 'content-length': 'nonsense' } }))
        .toEqual({ kind: 'preview', mimeType: 'image/png' });
    });

    it('accepts an entry whose recorded size is the full decoded length above the capture limit', () => {
      // The `request` fixture records decoded sizes with no 1 MiB cap.
      const big = new Uint8Array(2 * MiB);
      big.set(PNG);
      big.set(PNG_IEND, big.length - PNG_IEND.length);
      expect(plan({ body: big, contentType: 'image/png', headers: { 'content-encoding': 'gzip' } }))
        .toEqual({ kind: 'preview', mimeType: 'image/png' });
    });
  });

  describe('bytes that stop before the format\'s end marker', () => {
    // A chunked stream dropped on a chunk boundary dechunks without error, and
    // its sizes (wire size under the cap, no Content-Length) can't show the gap.
    const chunked = { 'transfer-encoding': 'chunked' };

    it('refuses a PNG with no IEND, a JPEG with no EOI, a GIF cut inside a block, a WebP short of its RIFF length', () => {
      const cut = (b: Uint8Array, n: number) => b.subarray(0, b.length - n);
      for (const [body, contentType] of [
        [cut(PNG, PNG_IEND.length), 'image/png'],
        [cut(JPEG, 2), 'image/jpeg'],
        [cut(GIF, 2), 'image/gif'],
        [cut(WEBP, 2), 'image/webp'],
      ] as const) {
        expect(plan({ body, contentType, headers: chunked }))
          .toEqual({ kind: 'unavailable', mimeType: contentType, reason: { code: 'incomplete' } });
      }
    });

    it('catches a partial upload the exchange no longer marks in flight', () => {
      expect(plan({ body: PNG.subarray(0, 12), contentType: 'image/png', direction: 'request', headers: chunked }))
        .toMatchObject({ reason: { code: 'incomplete' } });
    });

    it('accepts data a camera appended after the image (SEFT trailer, Motion Photo video)', () => {
      const trailer = new Uint8Array(5000).fill(0x5a);
      expect(plan({ body: new Uint8Array([...JPEG, ...trailer]), contentType: 'image/jpeg' }))
        .toEqual({ kind: 'preview', mimeType: 'image/jpeg' });
      expect(plan({ body: new Uint8Array([...PNG, ...trailer]), contentType: 'image/png' }))
        .toEqual({ kind: 'preview', mimeType: 'image/png' });
    });

    it('is not fooled by an EXIF thumbnail\'s end marker when the main image is cut', () => {
      // APP1 holding a complete thumbnail JPEG (with its own FFD9), then a scan cut short.
      const thumbnail = [0xff, 0xd8, 0xff, 0xd9];
      const app1 = [0xff, 0xe1, 0, 2 + thumbnail.length, ...thumbnail];
      const cut = new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xda, 0, 3, 1, 0x12, 0x34]);
      expect(plan({ body: cut, contentType: 'image/jpeg' })).toMatchObject({ reason: { code: 'incomplete' } });
    });

    it('follows a progressive JPEG through several scans', () => {
      const progressive = new Uint8Array([
        0xff, 0xd8,
        0xff, 0xda, 0, 3, 1, 0x11, 0x22,
        0xff, 0xc4, 0, 3, 0, // tables between scans
        0xff, 0xda, 0, 3, 1, 0x33,
        0xff, 0xd9,
      ]);
      expect(plan({ body: progressive, contentType: 'image/jpeg' })).toEqual({ kind: 'preview', mimeType: 'image/jpeg' });
      expect(plan({ body: progressive.subarray(0, 18), contentType: 'image/jpeg' })).toMatchObject({ reason: { code: 'incomplete' } });
    });

    it('judges the bytes by the format they are, not the type they were served as', () => {
      expect(plan({ body: JPEG.subarray(0, JPEG.length - 2), contentType: 'image/png', headers: chunked }))
        .toMatchObject({ reason: { code: 'incomplete' } });
    });

    it('tolerates padding after the end marker', () => {
      const padded = new Uint8Array([...JPEG, 0, 0, 0, 0]);
      expect(plan({ body: padded, contentType: 'image/jpeg' })).toEqual({ kind: 'preview', mimeType: 'image/jpeg' });
      const paddedGif = new Uint8Array([...GIF, 0, 0]);
      expect(plan({ body: paddedGif, contentType: 'image/gif' })).toEqual({ kind: 'preview', mimeType: 'image/gif' });
    });

    it('walks a GIF to its trailer, so data after it is fine and a cut is caught', () => {
      expect(plan({ body: new Uint8Array([...GIF, 0x41, 0x42, 0x43]), contentType: 'image/gif' }))
        .toEqual({ kind: 'preview', mimeType: 'image/gif' });
      // Cut inside the LZW data, at a byte that happens to be 0x3B.
      const cutOnSemicolon = new Uint8Array([...GIF.subarray(0, 22), 0x3b]);
      expect(plan({ body: cutOnSemicolon, contentType: 'image/gif' })).toMatchObject({ reason: { code: 'incomplete' } });
    });

    it('accepts a GIF whose encoder dropped the trailer, when every block is closed', () => {
      const noTrailer = GIF.subarray(0, GIF.length - 1);
      expect(plan({ body: noTrailer, contentType: 'image/gif' })).toEqual({ kind: 'preview', mimeType: 'image/gif' });
      // Cut inside the image's sub-blocks is still short.
      expect(plan({ body: GIF.subarray(0, GIF.length - 2), contentType: 'image/gif' })).toMatchObject({ reason: { code: 'incomplete' } });
      // A header with no image at all is short too.
      expect(plan({ body: GIF.subarray(0, 13), contentType: 'image/gif' })).toMatchObject({ reason: { code: 'incomplete' } });
    });

    it('checks BMP and ICO against the extent their headers declare', () => {
      expect(plan({ body: BMP, contentType: 'image/bmp' })).toEqual({ kind: 'preview', mimeType: 'image/bmp' });
      expect(plan({ body: BMP.subarray(0, 8), contentType: 'image/bmp' })).toMatchObject({ reason: { code: 'incomplete' } });
      expect(plan({ body: ICO, contentType: 'image/x-icon' })).toEqual({ kind: 'preview', mimeType: 'image/x-icon' });
      expect(plan({ body: ICO.subarray(0, 24), contentType: 'image/x-icon' })).toMatchObject({ reason: { code: 'incomplete' } });
    });

    it('does not judge formats it cannot walk (AVIF)', () => {
      const avif = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
      expect(plan({ body: avif, contentType: 'image/avif' })).toEqual({ kind: 'preview', mimeType: 'image/avif' });
    });
  });

  describe('leftover compression the runner could not undo', () => {
    it('recognises a zlib-wrapped deflate body by its header', () => {
      const zlib = new Uint8Array([0x78, 0x9c, 1, 2, 3]);
      expect(plan({ body: zlib, contentType: 'image/png', headers: { 'content-encoding': 'deflate' } }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/png', reason: { code: 'undecoded', encoding: 'deflate' } });
    });

    it('does not claim compression for br or raw deflate, which carry no header', () => {
      const opaque = new Uint8Array([0x0b, 0x02, 0x80, 0x68]);
      for (const encoding of ['br', 'deflate']) {
        expect(plan({ body: opaque, contentType: 'image/png', headers: { 'content-encoding': encoding } }))
          .toEqual({ kind: 'preview', mimeType: 'image/png' });
      }
    });

    it('treats an image served under the wrong image type as decoded', () => {
      // A PNG favicon labelled image/x-icon, decoded by the `request` fixture's fetch.
      expect(plan({ body: PNG, contentType: 'image/x-icon', headers: { 'content-encoding': 'zstd' } }))
        .toEqual({ kind: 'preview', mimeType: 'image/x-icon' });
    });

    it('treats decoded non-sniffed types (BMP, ICO, AVIF) under a coding the runner skips as decoded', () => {
      const cases = [
        [BMP, 'image/bmp'],
        [ICO, 'image/x-icon'],
        [new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]), 'image/avif'],
      ] as const;
      for (const [body, contentType] of cases) {
        expect(plan({ body, contentType, headers: { 'content-encoding': 'zstd' } }))
          .toEqual({ kind: 'preview', mimeType: contentType });
      }
    });
  });

  it('recognises UI mode\'s size placeholder instead of drawing it as the image', () => {
    for (const placeholder of [
      bodyPlaceholder(6 * MiB, 'stream live', 'response'),
      bodyPlaceholder(3 * MiB, 'display inline'),
    ]) {
      const body = new TextEncoder().encode(placeholder);
      expect(plan({ body, contentType: 'image/svg+xml', headers: { 'content-encoding': 'gzip' } }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/svg+xml', reason: { code: 'not-live' } });
      // Also under a type the browser can't display: the archive still has it.
      expect(plan({ body, contentType: 'image/tiff' }))
        .toEqual({ kind: 'unavailable', mimeType: 'image/tiff', reason: { code: 'not-live' } });
    }
  });

  it('refuses a 206 Partial Content response, whose Content-Length matches the slice', () => {
    expect(plan({ body: JPEG, contentType: 'image/jpeg', status: 206, headers: { 'Content-Length': String(JPEG.length), 'Content-Range': 'bytes 0-5/400000' } }))
      .toEqual({ kind: 'unavailable', mimeType: 'image/jpeg', reason: { code: 'partial-content' } });
    // The status is the response's; an upload on a 206 exchange is whole.
    expect(plan({ body: PNG, contentType: 'image/png', status: 206, direction: 'request' }))
      .toEqual({ kind: 'preview', mimeType: 'image/png' });
  });

  it('previews a 206 whose range is the whole resource (an open-ended Range: bytes=0-)', () => {
    const last = PNG.length - 1;
    for (const whole of [`bytes 0-${last}/${PNG.length}`, `bytes=0-${last}/${PNG.length}`, `bytes 0 - ${last} / ${PNG.length}`]) {
      expect(plan({ body: PNG, contentType: 'image/png', status: 206, headers: { 'Content-Range': whole } }))
        .toEqual({ kind: 'preview', mimeType: 'image/png' });
    }
    for (const partial of [`bytes 1-${PNG.length - 1}/${PNG.length}`, `bytes 0-${PNG.length - 1}/*`, 'garbage']) {
      expect(plan({ body: PNG, contentType: 'image/png', status: 206, headers: { 'content-range': partial } }))
        .toMatchObject({ reason: { code: 'partial-content' } });
    }
  });

  it('refuses an image that may still have been arriving, naming the direction', () => {
    expect(plan({ body: PNG, contentType: 'image/png', inFlight: true }))
      .toEqual({ kind: 'unavailable', mimeType: 'image/png', reason: { code: 'in-flight', direction: 'response' } });
    expect(plan({ body: PNG, contentType: 'image/png', inFlight: true, direction: 'request' }))
      .toMatchObject({ reason: { code: 'in-flight', direction: 'request' } });
    // Still downloading explains the short body — not truncation, and not the
    // mid-chunk framing or unfinished gzip stream a live download always has.
    expect(plan({ body: PNG, contentType: 'image/png', inFlight: true, headers: { 'content-length': '500000' } }))
      .toMatchObject({ reason: { code: 'in-flight' } });
    const liveChunked = new TextEncoder().encode('1000\r\n\u0089PNG\r\n');
    expect(plan({ body: liveChunked, contentType: 'image/png', inFlight: true, headers: { 'transfer-encoding': 'chunked' } }))
      .toMatchObject({ reason: { code: 'in-flight' } });
    expect(plan({ body: GZIP, contentType: 'image/png', inFlight: true, headers: { 'content-encoding': 'gzip' } }))
      .toMatchObject({ reason: { code: 'in-flight' } });
  });
});
