// PNG payloads for binary screen-mirror frames.
//
// Real frames are device screenshots; nothing in the SPA cares about their
// content beyond being decodable, so these are the smallest valid PNGs that
// still prove the payload survived the wire.

import * as zlib from "node:zlib"

/** A 1x1 opaque red PNG. */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
)

/**
 * A solid-colour PNG of arbitrary size, built rather than hard-coded so frame
 * dimensions can vary per test (rotation, a different device mid-session).
 */
export function solidPng(
  width = 8,
  height = 8,
  rgb: [number, number, number] = [255, 0, 0],
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      raw[o++] = rgb[0]
      raw[o++] = rgb[1]
      raw[o++] = rgb[2]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  // 10-12 default to 0: deflate, adaptive filtering, no interlace.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * A frame whose header dimensions agree with its payload, as the real server
 * always emits (both come from the same screenshot).
 *
 * Worth knowing which is which: `use-screen-mirror.ts` sizes the canvas from
 * the decoded bitmap, while the header dimensions feed `getScreenSize()` for
 * normalising mirror gesture coordinates.
 */
export function screenFrame(width: number, height: number, seq?: number) {
  return { width, height, seq, png: solidPng(width, height) }
}
