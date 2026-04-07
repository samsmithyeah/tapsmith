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
  buildSudoersRule,
  setupProxy,
  isProxySetupInstalled,
  removeProxySetup,
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
  it('returns true immediately when sudo -n networksetup succeeds (cached or NOPASSWD)', () => {
    mockedExecFileSync.mockReturnValue('')

    expect(ensureSudoAccess()).toBe(true)
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'sudo', ['-n', 'networksetup', '-listallnetworkservices'], { stdio: 'pipe' },
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
    expect(output).toContain('npx pilot setup-proxy')

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

// ─── buildSudoersRule ───

describe('buildSudoersRule', () => {
  it('generates a rule for the current user', () => {
    const originalUser = process.env.USER
    process.env.USER = 'testuser'
    try {
      const rule = buildSudoersRule()
      expect(rule).toContain('testuser ALL=(root) NOPASSWD: /usr/sbin/networksetup')
      expect(rule).toContain('# Allow Pilot')
    } finally {
      process.env.USER = originalUser
    }
  })

  it('falls back to whoami when env vars are unset', () => {
    const originalUser = process.env.USER
    const originalLogname = process.env.LOGNAME
    delete process.env.USER
    delete process.env.LOGNAME
    mockedExecFileSync.mockReturnValue('whoamiuser\n')
    try {
      const rule = buildSudoersRule()
      expect(rule).toContain('whoamiuser ALL=(root) NOPASSWD:')
      expect(mockedExecFileSync).toHaveBeenCalledWith('whoami', { encoding: 'utf8' })
    } finally {
      process.env.USER = originalUser
      process.env.LOGNAME = originalLogname
    }
  })
})

// ─── isProxySetupInstalled ───

describe('isProxySetupInstalled', () => {
  it('returns true when sudo -n networksetup succeeds', () => {
    mockedExecFileSync.mockReturnValue('')
    expect(isProxySetupInstalled()).toBe(true)
  })

  it('returns false when sudo -n networksetup fails', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('sudo: a password is required')
    })
    expect(isProxySetupInstalled()).toBe(false)
  })
})

// ─── setupProxy ───

describe('setupProxy', () => {
  it('skips if already installed', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // sudo -n networksetup succeeds → already installed
    mockedExecFileSync.mockReturnValue('')

    expect(setupProxy()).toBe(true)
    const output = writeSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('already configured')

    writeSpy.mockRestore()
  })

  it('writes sudoers file and validates it', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls: Array<{ cmd: string; args: string[] }> = []
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      calls.push({ cmd, args: [...args] })
      // isProxySetupInstalled check fails (not yet installed)
      if (cmd === 'sudo' && args[0] === '-n' && args[1] === 'networksetup') {
        throw new Error('sudo: a password is required')
      }
      return ''
    })

    expect(setupProxy()).toBe(true)

    // Should have called tee, chmod, and visudo -c
    expect(calls.find((c) => c.cmd === 'sudo' && c.args[0] === 'tee')).toBeTruthy()
    expect(calls.find((c) => c.cmd === 'sudo' && c.args[0] === 'chmod')).toBeTruthy()
    expect(calls.find((c) => c.cmd === 'sudo' && c.args[0] === 'visudo')).toBeTruthy()

    writeSpy.mockRestore()
  })

  it('removes file if visudo validation fails', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls: Array<{ cmd: string; args: string[] }> = []
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      calls.push({ cmd, args: [...args] })
      if (cmd === 'sudo' && args[0] === '-n' && args[1] === 'networksetup') {
        throw new Error('sudo: a password is required')
      }
      if (cmd === 'sudo' && args[0] === 'visudo') {
        throw new Error('visudo: parse error')
      }
      return ''
    })

    expect(setupProxy()).toBe(false)
    expect(calls.find((c) => c.cmd === 'sudo' && c.args[0] === 'rm')).toBeTruthy()

    const output = writeSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('validation failed')

    writeSpy.mockRestore()
  })

  it('returns false when user cancels sudo prompt', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockedExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'sudo' && args[0] === '-n') {
        throw new Error('sudo: a password is required')
      }
      // tee fails (user cancelled)
      if (cmd === 'sudo' && args[0] === 'tee') {
        throw new Error('sudo cancelled')
      }
      return ''
    })

    expect(setupProxy()).toBe(false)
    const output = writeSpy.mock.calls.map((c) => c[0]).join('')
    expect(output).toContain('cancelled')

    writeSpy.mockRestore()
  })
})

// ─── removeProxySetup ───

describe('removeProxySetup', () => {
  it('removes the sudoers file', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockedExecFileSync.mockReturnValue('')

    expect(removeProxySetup()).toBe(true)
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'sudo', ['rm', '-f', '/etc/sudoers.d/pilot-networksetup'],
      expect.objectContaining({ stdio: 'inherit' }),
    )

    writeSpy.mockRestore()
  })

  it('returns false when rm fails', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('sudo failed')
    })

    expect(removeProxySetup()).toBe(false)

    writeSpy.mockRestore()
  })
})
