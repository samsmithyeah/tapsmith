/**
 * Shared trace-recording wrapper for actions on Device and ElementHandle.
 *
 * Both classes need identical before/after screenshot + hierarchy capture,
 * element bounds lookup, and event emission logic. This module extracts that
 * common flow so neither class duplicates it.
 */

import type { TraceCollector } from './trace-collector.js'
import { extractSourceLocation } from './trace-collector.js'
import type { ActionCategory } from './types.js'
import type { ActionResponse, ElementInfo } from '../grpc-client.js'
import type { Selector } from '../selectors.js'
import { selectorToProto } from '../selectors.js'

// ─── Trace context ───

export interface TraceContext {
  collector: TraceCollector
  takeScreenshot: () => Promise<Buffer | undefined>
  captureHierarchy: () => Promise<string | undefined>
  findElement?: (selector: Selector, timeoutMs: number) => Promise<{ found: boolean; element?: ElementInfo }>
}

// ─── Shared helper ───

export async function tracedAction(
  ctx: TraceContext | undefined,
  action: string,
  category: ActionCategory,
  selector: Selector | undefined,
  fn: () => Promise<ActionResponse>,
  fallbackMsg: string,
  extra?: { inputValue?: string },
): Promise<void> {
  // No trace context — just run the action directly
  if (!ctx) {
    const res = await fn()
    if (!res.success) {
      throw new Error(res.errorMessage || fallbackMsg)
    }
    return
  }

  const sourceLocation = extractSourceLocation(new Error().stack ?? '')
  const selectorStr = selector ? JSON.stringify(selectorToProto(selector)) : undefined
  const log: string[] = []

  // Best-effort element bounds lookup for trace overlay
  let bounds: { left: number; top: number; right: number; bottom: number } | undefined
  let point: { x: number; y: number } | undefined
  if (selector && ctx.findElement) {
    const lookupStart = Date.now()
    try {
      const res = await ctx.findElement(selector, 500)
      if (res.found && res.element?.bounds) {
        bounds = res.element.bounds
        log.push(`Element found at [${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}] (${Date.now() - lookupStart}ms)`)
        if (category === 'tap') {
          point = {
            x: (bounds.left + bounds.right) / 2,
            y: (bounds.top + bounds.bottom) / 2,
          }
          log.push(`Tap target: (${point.x}, ${point.y})`)
        }
      } else {
        log.push(`Element lookup returned no match (${Date.now() - lookupStart}ms)`)
      }
    } catch {
      log.push(`Element lookup failed (${Date.now() - lookupStart}ms)`)
    }
  }

  log.push('Capturing before screenshot + hierarchy')

  const { actionIndex, captures: beforeCaptures } = await ctx.collector.captureBeforeAction(
    ctx.takeScreenshot, ctx.captureHierarchy,
  )

  const start = Date.now()
  let success = true
  let error: string | undefined
  let errorStack: string | undefined

  try {
    const res = await fn()
    if (!res.success) {
      success = false
      error = res.errorMessage || fallbackMsg
      throw new Error(error)
    }
  } catch (err) {
    success = false
    if (err instanceof Error) { error = err.message; errorStack = err.stack }
    else { error = String(err) }
    log.push(`Action failed: ${error} (${Date.now() - start}ms)`)

    const afterCaptures = await ctx.collector.captureAfterAction(
      actionIndex, ctx.takeScreenshot, ctx.captureHierarchy,
    )
    ctx.collector.addActionEvent({
      category, action, selector: selectorStr, inputValue: extra?.inputValue,
      duration: Date.now() - start, success, error, errorStack,
      bounds, point, log,
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: !!afterCaptures.screenshotAfter,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: !!afterCaptures.hierarchyAfter,
      sourceLocation,
    })
    throw err instanceof Error ? err : new Error(String(err))
  }

  log.push(`Action completed successfully (${Date.now() - start}ms)`)

  const afterCaptures = await ctx.collector.captureAfterAction(
    actionIndex, ctx.takeScreenshot, ctx.captureHierarchy,
  )
  ctx.collector.addActionEvent({
    category, action, selector: selectorStr, inputValue: extra?.inputValue,
    duration: Date.now() - start, success,
    bounds, point, log,
    hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
    hasScreenshotAfter: !!afterCaptures.screenshotAfter,
    hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
    hasHierarchyAfter: !!afterCaptures.hierarchyAfter,
    sourceLocation,
  })
}
