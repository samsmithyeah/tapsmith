import { describe, it, expect, vi } from 'vitest'
import {
  findAvailablePort,
  serialForPort,
  probeDeviceHealth,
  filterHealthyDevices,
  provisionEmulators,
} from '../emulator.js'

describe('emulator utilities', () => {
  describe('findAvailablePort', () => {
    it('returns base port when no ports are used', () => {
      expect(findAvailablePort(new Set())).toBe(5554)
    })

    it('skips used ports', () => {
      expect(findAvailablePort(new Set([5554]))).toBe(5556)
    })

    it('skips multiple used ports', () => {
      expect(findAvailablePort(new Set([5554, 5556, 5558]))).toBe(5560)
    })

    it('finds first gap in used ports', () => {
      expect(findAvailablePort(new Set([5554, 5558]))).toBe(5556)
    })
  })

  describe('serialForPort', () => {
    it('formats serial from port', () => {
      expect(serialForPort(5554)).toBe('emulator-5554')
      expect(serialForPort(5556)).toBe('emulator-5556')
    })
  })

  describe('probeDeviceHealth', () => {
    it('accepts a healthy emulator', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|echo|__pilot_health_ok__': '__pilot_health_ok__\n',
        'adb|-s|emulator-5554|shell|getprop|sys.boot_completed': '1\n',
        'adb|-s|emulator-5554|shell|pm|path|android': 'package:/system/framework/framework-res.apk\n',
      })

      expect(probeDeviceHealth('emulator-5554', exec)).toEqual({
        serial: 'emulator-5554',
        healthy: true,
      })
    })

    it('rejects an unresponsive adb shell', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|echo|__pilot_health_ok__': new Error('timeout'),
      })

      expect(probeDeviceHealth('emulator-5554', exec)).toEqual({
        serial: 'emulator-5554',
        healthy: false,
        reason: 'ADB shell is unresponsive',
      })
    })

    it('rejects an emulator that is not fully booted', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|echo|__pilot_health_ok__': '__pilot_health_ok__\n',
        'adb|-s|emulator-5554|shell|getprop|sys.boot_completed': '0\n',
      })

      expect(probeDeviceHealth('emulator-5554', exec)).toEqual({
        serial: 'emulator-5554',
        healthy: false,
        reason: 'emulator is not fully booted',
      })
    })

    it('rejects a device with an unresponsive package manager', () => {
      const exec = makeExec({
        'adb|-s|device-123|shell|echo|__pilot_health_ok__': '__pilot_health_ok__\n',
        'adb|-s|device-123|shell|pm|path|android': new Error('pm hung'),
      })

      expect(probeDeviceHealth('device-123', exec)).toEqual({
        serial: 'device-123',
        healthy: false,
        reason: 'package manager is unresponsive',
      })
    })
  })

  describe('filterHealthyDevices', () => {
    it('returns healthy serials and unhealthy probe results', () => {
      const exec = makeExec({
        'adb|-s|emulator-5554|shell|echo|__pilot_health_ok__': '__pilot_health_ok__\n',
        'adb|-s|emulator-5554|shell|getprop|sys.boot_completed': '1\n',
        'adb|-s|emulator-5554|shell|pm|path|android': 'package:/system/framework/framework-res.apk\n',
        'adb|-s|emulator-5556|shell|echo|__pilot_health_ok__': '__pilot_health_ok__\n',
        'adb|-s|emulator-5556|shell|getprop|sys.boot_completed': '0\n',
      })

      expect(filterHealthyDevices(['emulator-5554', 'emulator-5556'], exec)).toEqual({
        healthySerials: ['emulator-5554'],
        unhealthyDevices: [{
          serial: 'emulator-5556',
          healthy: false,
          reason: 'emulator is not fully booted',
        }],
      })
    })
  })

  describe('provisionEmulators', () => {
    it('falls back to an alternative AVD when the requested one boots unhealthy', async () => {
      const killed: string[] = []
      const launchedAvds: string[] = []

      const result = await provisionEmulators(
        {
          existingSerials: [],
          workers: 1,
          avd: 'Broken_API_35',
        },
        {
          listAvds: () => ['Broken_API_35', 'Pixel_9_API_35'],
          getRunningAvdName: () => undefined,
          launchEmulator: (avd, port) => {
            launchedAvds.push(avd)
            return makeLaunchedEmulator(avd, port)
          },
          waitForBoot: async () => undefined,
          probeDeviceHealth: (serial) => serial === 'emulator-5554'
            ? { serial, healthy: false, reason: 'package manager is unresponsive' }
            : { serial, healthy: true },
          killEmulator: (serial) => {
            killed.push(serial)
          },
        },
      )

      expect(launchedAvds).toEqual(['Broken_API_35', 'Pixel_9_API_35'])
      expect(killed).toEqual(['emulator-5554'])
      expect(result.allSerials).toEqual(['emulator-5556'])
      expect(result.launched.map((emu) => emu.avd)).toEqual(['Pixel_9_API_35'])
    })

    it('returns existing devices when all launch candidates fail', async () => {
      const result = await provisionEmulators(
        {
          existingSerials: ['emulator-5554'],
          workers: 2,
          avd: 'Broken_API_35',
        },
        {
          listAvds: () => ['Broken_API_35'],
          getRunningAvdName: () => undefined,
          launchEmulator: (avd, port) => makeLaunchedEmulator(avd, port),
          waitForBoot: async () => {
            throw new Error('boot timed out')
          },
          probeDeviceHealth: () => ({ serial: 'unused', healthy: true }),
          killEmulator: vi.fn(),
        },
      )

      expect(result.allSerials).toEqual(['emulator-5554'])
      expect(result.launched).toEqual([])
    })
  })
})

function makeExec(responses: Record<string, string | Error>) {
  return ((file: string, args: string[]) => {
    const key = [file, ...args].join('|')
    const response = responses[key]
    if (response instanceof Error) {
      throw response
    }
    if (response === undefined) {
      throw new Error(`Unexpected command: ${key}`)
    }
    return response
  }) as unknown as typeof import('node:child_process').execFileSync
}

function makeLaunchedEmulator(avd: string, port: number) {
  return {
    avd,
    port,
    serial: serialForPort(port),
    process: {
      kill: vi.fn(),
    },
  } as unknown as import('../emulator.js').LaunchedEmulator
}
