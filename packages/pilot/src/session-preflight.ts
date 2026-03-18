import type { PilotConfig } from './config.js'
import type { Device } from './device.js'
import type { LaunchAppOptions, PilotGrpcClient } from './grpc-client.js'

type SessionDevice = Pick<Device, 'startAgent' | 'terminateApp' | 'launchApp' | 'waitForIdle' | 'currentPackage'>
type SessionClient = Pick<PilotGrpcClient, 'ping' | 'getUiHierarchy'>

export interface SessionPreflightContext {
  label: string
  config: Pick<PilotConfig, 'package' | 'activity'>
  device: SessionDevice
  client: SessionClient
  agentApkPath?: string
  agentTestApkPath?: string
}

const DEFAULT_READY_TIMEOUT_MS = 5_000
const DEFAULT_MAX_ATTEMPTS = 2

export async function ensureSessionReady(
  ctx: SessionPreflightContext,
  phase: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<void> {
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await verifySession(ctx)
      return
    } catch (err) {
      lastError = err
      if (attempt === maxAttempts) break
      await recoverSession(ctx)
    }
  }

  throw new Error(
    `${ctx.label}: session preflight failed during ${phase}: ${formatError(lastError)}`,
  )
}

export async function launchConfiguredApp(
  ctx: SessionPreflightContext,
  phase: string,
): Promise<void> {
  if (!ctx.config.package) {
    await ensureSessionReady(ctx, phase)
    return
  }

  try {
    await ctx.device.terminateApp(ctx.config.package)
  } catch {
    // App may not be running yet
  }

  await ctx.device.launchApp(ctx.config.package, launchOptions(ctx.config))
  await ensureSessionReady(ctx, phase)
}

async function verifySession(ctx: SessionPreflightContext): Promise<void> {
  const pong = await ctx.client.ping()
  if (!pong.agentConnected) {
    throw new Error('agent is not connected')
  }

  await ctx.device.waitForIdle(DEFAULT_READY_TIMEOUT_MS)

  const hierarchy = await ctx.client.getUiHierarchy()
  if (!hierarchy.hierarchyXml.trim()) {
    throw new Error('UI hierarchy is empty')
  }

  if (ctx.config.package) {
    const currentPackage = await ctx.device.currentPackage()
    if (currentPackage !== ctx.config.package) {
      throw new Error(
        `foreground package mismatch (expected ${ctx.config.package}, got ${currentPackage || '(none)'})`,
      )
    }
  }
}

async function recoverSession(ctx: SessionPreflightContext): Promise<void> {
  await ctx.device.startAgent('', ctx.agentApkPath, ctx.agentTestApkPath)
  if (!ctx.config.package) return

  try {
    await ctx.device.terminateApp(ctx.config.package)
  } catch {
    // App may not be running
  }

  await ctx.device.launchApp(ctx.config.package, launchOptions(ctx.config))
}

function launchOptions(config: Pick<PilotConfig, 'activity'>): LaunchAppOptions {
  return {
    ...(config.activity ? { activity: config.activity } : {}),
    waitForIdle: false,
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
