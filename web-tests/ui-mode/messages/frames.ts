// Screen-mirror frame fixtures.

import { solidPng } from "../../png.js"

export { PNG_1X1, solidPng } from "../../png.js"

/**
 * A frame whose header dimensions agree with its payload, as the real server
 * always emits (both come from the same screenshot).
 *
 * Worth knowing which is which: `use-screen-mirror.ts` sizes the canvas from the
 * decoded bitmap, while the header dimensions feed `getScreenSize()` for
 * normalising mirror gesture coordinates.
 */
export function screenFrame(width: number, height: number, seq?: number) {
  return { width, height, seq, png: solidPng(width, height) }
}
