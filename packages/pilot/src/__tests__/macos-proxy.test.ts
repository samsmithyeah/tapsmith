import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as childProcess from 'node:child_process'

vi.mock('node:child_process')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded execFileSync signatures make proper mock typing impractical
const mockedExecFileSync = vi.mocked(childProcess.execFileSync) as any

import {
  detectActiveNetworkService,
  ensureSudoAccess,
  setMacProxy,
  clearMacProxy,
  _resetState,
} from '../macos-proxy.js'

beforeEach(() => {
  vi.clearAllMocks()
  _resetState()
})

// ─── detectActiveNetworkService ───

describe('detectActiveNetworkService', () => {
  it('returns the first service with an active interface', () => {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'networksetup') {
        return [
          '(1) Thunderbolt Ethernet',
          '(Hardware Port: Thunderbolt Ethernet, Device: en0)',
          '',
          '(2) Wi-Fi',
          '(Hardware Port: Wi-Fi, Device: en1)',
        ].join('\n')
      }
      if (cmd === 'ifconfig' && args[0] === 'en0') {
        return 'inet 10.0.0.1 status: active'
      }
      return ''
    })

    expect(detectActiveNetworkService()).toBe('Thunderbolt Ethernet')
  })

  it('skips interfaces without active inet and returns next match', () => {
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'networksetup') {
        return [
          '(1) Thunderbolt Ethernet',
          '(Hardware Port: Thunderbolt Ethernet, Device: en0)',
          '',
          '(2) Wi-Fi',
          '(Hardware Port: Wi-Fi, Device: en1)',
        ].join('\n')
      }
      if (cmd === 'ifconfig' && args[0] === 'en0') {
        return 'status: inactive'
      }
      if (cmd === 'ifconfig' && args[0] === 'en1') {
        return 'inet 192.168.1.1 status: active'
      }
      return ''
    })

    expect(detectActiveNetworkService()).toBe('Wi-Fi')
  })

  it('falls back to Wi-Fi when networksetup is unavailable', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })

    expect(detectActiveNetworkService()).toBe('Wi-Fi')
  })

  it('falls back to Wi-Fi when no interfaces are active', () => {
    mockedExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'networksetup') {
        return [
          '(1) Wi-Fi',
          '(Hardware Port: Wi-Fi, Device: en0)',
        ].join('\n')
      }
      if (cmd === 'ifconfig') {
        return 'status: inactive'
      }
      return ''
    })

    expect(detectActiveNetworkService()).toBe('Wi-Fi')
  })
})

// ─── ensureSudoAccess ───

describe('ensureSudoAccess', () => {
  it('returns true immediately when sudo -n succeeds (cached credentials)', () => {
    mockedExecFileSync.mockReturnValue('')

    expect(ensureSudoAccess()).toBe(true)
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'sudo', ['-n', 'true'], { stdio: 'pipe' },
    )
  })

  it('falls back to interactive sudo -v when sudo -n fails', () => {
    let callCount = 0
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      callCount++
      // First call: sudo -n true fails
      if (cmd === 'sudo' && args[0] === '-n') {
        throw new Error('sudo: a password is required')
      }
      // Second call: sudo -v succeeds (user entered password)
      return ''
    })

    expect(ensureSudoAccess()).toBe(true)
    // Should have called sudo -n, then sudo -v
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'sudo', ['-v'], expect.objectContaining({ stdio: 'inherit' }),
    )
  })

  it('returns false when user declines the password prompt', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('sudo failed')
    })

    expect(ensureSudoAccess()).toBe(false)
  })

  it('does not re-prompt after user declines', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('sudo failed')
    })

    ensureSudoAccess()
    vi.clearAllMocks()

    // Second call should return false immediately without any exec calls
    expect(ensureSudoAccess()).toBe(false)
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })

  it('does not re-prompt after sudo succeeds', () => {
    mockedExecFileSync.mockReturnValue('')
    ensureSudoAccess()
    vi.clearAllMocks()

    // Second call should return true immediately with no exec calls
    expect(ensureSudoAccess()).toBe(true)
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })

  it('prints explanation before prompting for password', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let callCount = 0
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'sudo' && args[0] === '-n') {
        throw new Error('sudo: a password is required')
      }
      return ''
    })

    ensureSudoAccess()

    const output = writeSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('system proxy')
    expect(output).toContain('HTTP traffic')
    expect(output).toContain('not stored')

    writeSpy.mockRestore()
  })

  it('prints friendly message when user declines', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('sudo failed')
    })

    ensureSudoAccess()

    const output = writeSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('skipping network capture')

    writeSpy.mockRestore()
  })
})

// ─── setMacProxy ───

describe('setMacProxy', () => {
  it('returns null when sudo access is unavailable', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('sudo failed')
    })

    expect(setMacProxy(8080)).toBeNull()
  })

  it('sets both HTTP and HTTPS proxy and returns service name', () => {
    const calls: string[][] = []
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      if (cmd === 'networksetup' && args[0] === '-listnetworkserviceorder') {
        return [
          '(1) Wi-Fi',
          '(Hardware Port: Wi-Fi, Device: en0)',
        ].join('\n')
      }
      if (cmd === 'ifconfig') {
        return 'inet 192.168.1.1 status: active'
      }
      return ''
    })

    const result = setMacProxy(9090)
    expect(result).toBe('Wi-Fi')

    const setWebProxy = calls.find(
      (c) => c[0] === 'sudo' && c.includes('-setwebproxy'),
    )
    expect(setWebProxy).toEqual([
      'sudo', '-n', 'networksetup', '-setwebproxy', 'Wi-Fi', '127.0.0.1', '9090',
    ])

    const setSecureProxy = calls.find(
      (c) => c[0] === 'sudo' && c.includes('-setsecurewebproxy'),
    )
    expect(setSecureProxy).toEqual([
      'sudo', '-n', 'networksetup', '-setsecurewebproxy', 'Wi-Fi', '127.0.0.1', '9090',
    ])
  })

  it('returns null when proxy set command fails', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      // sudo -n true succeeds (access check)
      if (cmd === 'sudo' && args[0] === '-n' && args[1] === 'true') return ''
      // networksetup service detection
      if (cmd === 'networksetup') {
        return '(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n'
      }
      if (cmd === 'ifconfig') return 'inet 10.0.0.1 status: active'
      // Proxy set call fails
      if (cmd === 'sudo' && args.includes('-setwebproxy')) {
        throw new Error('networksetup error')
      }
      return ''
    })

    expect(setMacProxy(8080)).toBeNull()

    writeSpy.mockRestore()
  })
})

// ─── clearMacProxy ───

describe('clearMacProxy', () => {
  it('disables both HTTP and HTTPS proxy for the given service', () => {
    const calls: string[][] = []
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return ''
    })

    clearMacProxy('Ethernet')

    const disableHttp = calls.find(
      (c) => c[0] === 'sudo' && c.includes('-setwebproxystate'),
    )
    expect(disableHttp).toEqual([
      'sudo', '-n', 'networksetup', '-setwebproxystate', 'Ethernet', 'off',
    ])

    const disableHttps = calls.find(
      (c) => c[0] === 'sudo' && c.includes('-setsecurewebproxystate'),
    )
    expect(disableHttps).toEqual([
      'sudo', '-n', 'networksetup', '-setsecurewebproxystate', 'Ethernet', 'off',
    ])
  })

  it('does not throw when networksetup fails', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('networksetup error')
    })

    expect(() => clearMacProxy('Wi-Fi')).not.toThrow()
  })
})
