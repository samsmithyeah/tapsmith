/**
 * macOS system proxy management for iOS network capture.
 *
 * iOS simulators share the host's network stack, so capturing HTTP/HTTPS
 * traffic requires routing it through a proxy at the OS level. This module
 * manages the macOS system proxy via `networksetup`.
 *
 * On first use, if `sudo -n` (passwordless) doesn't work, we explain why
 * and prompt for the user's password in the terminal. sudo caches the
 * credential for the remainder of the session so subsequent calls don't
 * re-prompt.
 */

import { execFileSync } from 'node:child_process'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/**
 * Detect the active macOS network service (e.g. "Wi-Fi", "Ethernet").
 * Walks the service order list and returns the first service whose
 * network interface has an active inet address. Falls back to "Wi-Fi".
 */
export function detectActiveNetworkService(): string {
  try {
    const order = execFileSync('networksetup', ['-listnetworkserviceorder'], { encoding: 'utf8' })
    let currentService: string | null = null
    for (const line of order.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('(') && !trimmed.includes('Hardware Port')) {
        const match = trimmed.match(/^\(\d+\)\s+(.+)$/)
        if (match) currentService = match[1]
      }
      if (currentService && trimmed.includes('Hardware Port')) {
        const devMatch = trimmed.match(/Device:\s*(\w+)/)
        if (devMatch?.[1]) {
          try {
            const ifout = execFileSync('ifconfig', [devMatch[1]], { encoding: 'utf8' })
            if (ifout.includes('inet ') && ifout.includes('status: active')) return currentService
          } catch { /* interface not found */ }
        }
        currentService = null
      }
    }
  } catch { /* networksetup not available */ }
  return 'Wi-Fi'
}

/** Whether we've already acquired sudo access this session. */
let _sudoAcquired = false
/** Whether the user has already declined the sudo prompt this session. */
let _sudoDeclined = false

/**
 * Ensure sudo access to networksetup is available.
 *
 * 1. Try `sudo -n` (passwordless) — works if credentials are cached or
 *    a NOPASSWD sudoers rule exists.
 * 2. If that fails, explain why we need it and run `sudo -v` with
 *    stdio: 'inherit' so the user sees the password prompt in their
 *    terminal. sudo then caches the credential (~5 min default).
 * 3. If the user declines (Ctrl+C or wrong password), remember for the
 *    rest of this session and don't re-prompt.
 */
export function ensureSudoAccess(): boolean {
  if (_sudoAcquired) return true
  if (_sudoDeclined) return false

  // Fast path: already cached or NOPASSWD rule exists
  try {
    execFileSync('sudo', ['-n', 'true'], { stdio: 'pipe' })
    _sudoAcquired = true
    return true
  } catch { /* need interactive prompt */ }

  // Explain what we need and why before the password prompt appears
  process.stderr.write(
    `\n${DIM}iOS simulators share your Mac's network, so Pilot needs to briefly set a` +
    `\nsystem proxy to capture HTTP traffic for trace recording.` +
    `\nThis requires your macOS password (used once per session, not stored).${RESET}\n\n`,
  )

  try {
    // sudo -v validates and caches credentials without running a command.
    // stdio: 'inherit' connects the password prompt to the user's terminal.
    execFileSync('sudo', ['-v'], { stdio: 'inherit', timeout: 60_000 })
    _sudoAcquired = true
    return true
  } catch {
    _sudoDeclined = true
    process.stderr.write(
      `${DIM}No problem — skipping network capture for this run.${RESET}\n\n`,
    )
    return false
  }
}

/** Reset internal state (for testing). */
export function _resetState(): void {
  _sudoAcquired = false
  _sudoDeclined = false
  _activeProxyService = null
  _proxyExitHandlerInstalled = false
}

let _activeProxyService: string | null = null
let _proxyExitHandlerInstalled = false

function installProxyExitHandler(): void {
  if (_proxyExitHandlerInstalled) return
  _proxyExitHandlerInstalled = true
  const cleanup = () => {
    if (_activeProxyService) {
      try {
        execFileSync('sudo', ['-n', 'networksetup', '-setwebproxystate', _activeProxyService, 'off'], { stdio: 'pipe' })
        execFileSync('sudo', ['-n', 'networksetup', '-setsecurewebproxystate', _activeProxyService, 'off'], { stdio: 'pipe' })
      } catch { /* best-effort — sudo cache may have expired on very long runs */ }
      _activeProxyService = null
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => { cleanup(); process.exit(130) })
  process.on('SIGTERM', () => { cleanup(); process.exit(143) })
}

/**
 * Configure macOS system proxy to route through the given port.
 * Returns the network service name on success, or null if proxy
 * couldn't be set (no sudo access, networksetup failure, etc.).
 */
export function setMacProxy(port: number): string | null {
  if (!ensureSudoAccess()) return null
  const service = detectActiveNetworkService()
  try {
    execFileSync('sudo', ['-n', 'networksetup', '-setwebproxy', service, '127.0.0.1', String(port)], { stdio: 'pipe' })
    execFileSync('sudo', ['-n', 'networksetup', '-setsecurewebproxy', service, '127.0.0.1', String(port)], { stdio: 'pipe' })
  } catch {
    process.stderr.write(`${DIM}Failed to set macOS proxy — network capture disabled.${RESET}\n`)
    return null
  }
  _activeProxyService = service
  installProxyExitHandler()
  return service
}

/**
 * Disable the macOS system proxy for the given network service.
 */
export function clearMacProxy(service: string): void {
  try {
    execFileSync('sudo', ['-n', 'networksetup', '-setwebproxystate', service, 'off'], { stdio: 'pipe' })
    execFileSync('sudo', ['-n', 'networksetup', '-setsecurewebproxystate', service, 'off'], { stdio: 'pipe' })
  } catch { /* best-effort */ }
  _activeProxyService = null
}
