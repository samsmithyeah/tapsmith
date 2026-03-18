import { describe, it, expect, vi } from 'vitest'
import {
  findAvailablePort,
  serialForPort,
  probeDeviceHealth,
  filterHealthyDevices,
  provisionEmulators,
  selectDevicesForStrategy,
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

  describe('selectDevicesForStrategy', () => {
    it('returns all devices for prefer-connected', () => {
      expect(
        selectDevicesForStrategy(['emulator-5554', 'device-123'], 'prefer-connected', 'Pixel_9_API_35'),
      ).toEqual({
        selectedSerials: ['emulator-5554', 'device-123'],
        skippedDevices: [],
      })
    })

    it('keeps only matching AVD instances for avd-only', () => {
      expect(
        selectDevicesForStrategy(
          ['emulator-5554', 'emulator-5556', 'device-123'],
          'avd-only',
          'Pixel_9_API_35',
          (serial) => serial === 'emulator-5554' ? 'Pixel_9_API_35' : 'Small_Phone_API_35',
        ),
      ).toEqual({
        selectedSerials: ['emulator-5554'],
        skippedDevices: [
          {
            serial: 'emulator-5556',
            reason: 'running AVD Small_Phone_API_35 does not match requested AVD Pixel_9_API_35',
          },
          {
            serial: 'device-123',
            reason: 'device is not an emulator instance of requested AVD Pixel_9_API_35',
          },
        ],
      })
    })

    it('requires avd when avd-only is selected', () => {
      expect(() => selectDevicesForStrategy(['emulator-5554'], 'avd-only', undefined)).toThrow(
        'deviceStrategy "avd-only" requires `avd` to be set in config',
      )
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

    it('keeps the requested AVD first even when another instance is already running', async () => {
      const launchedAvds: string[] = []

      const result = await provisionEmulators(
        {
          existingSerials: ['emulator-5554'],
          workers: 2,
          avd: 'Pixel_9_API_35',
        },
        {
          listAvds: () => ['Pixel_9_API_35', 'Small_Phone_API_35'],
          getRunningAvdName: (serial) => serial === 'emulator-5554' ? 'Pixel_9_API_35' : undefined,
          launchEmulator: (avd, port) => {
            launchedAvds.push(avd)
            return makeLaunchedEmulator(avd, port)
          },
          waitForBoot: async () => undefined,
          probeDeviceHealth: (serial) => ({ serial, healthy: true }),
          killEmulator: vi.fn(),
        },
      )

      expect(launchedAvds).toEqual(['Pixel_9_API_35'])
      expect(result.allSerials).toEqual(['emulator-5554', 'emulator-5556'])
      expect(result.launched.map((emu) => emu.avd)).toEqual(['Pixel_9_API_35'])
    })

    it('avoids occupied emulator ports even when those devices are not counted as existing workers', async () => {
      const launchedPorts: number[] = []

      const result = await provisionEmulators(
        {
          existingSerials: [],
          occupiedSerials: ['emulator-5554'],
          workers: 1,
          avd: 'Pixel_9_API_35',
        },
        {
          listAvds: () => ['Pixel_9_API_35'],
          getRunningAvdName: () => 'Small_Phone_API_35',
          launchEmulator: (avd, port) => {
            launchedPorts.push(port)
            return makeLaunchedEmulator(avd, port)
          },
          waitForBoot: async () => undefined,
          probeDeviceHealth: (serial) => ({ serial, healthy: true }),
          killEmulator: vi.fn(),
        },
      )

      expect(launchedPorts).toEqual([5556])
      expect(result.allSerials).toEqual(['emulator-5556'])
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
