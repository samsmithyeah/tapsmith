import { describe, it, expect, vi } from 'vitest'
import { Device } from '../device.js'
import { text, role } from '../selectors.js'
import type { PilotGrpcClient, ActionResponse } from '../grpc-client.js'

// ─── Mock helpers ───

function successResponse(): ActionResponse {
  return {
    requestId: '1',
    success: true,
    errorType: '',
    errorMessage: '',
    screenshot: Buffer.alloc(0),
  }
}

function failureResponse(msg = 'Action failed'): ActionResponse {
  return {
    requestId: '1',
    success: false,
    errorType: 'ERROR',
    errorMessage: msg,
    screenshot: Buffer.alloc(0),
  }
}

function makeMockClient(overrides: Partial<PilotGrpcClient> = {}): PilotGrpcClient {
  return {
    doubleTap: vi.fn(async () => successResponse()),
    dragAndDrop: vi.fn(async () => successResponse()),
    pinchZoom: vi.fn(async () => successResponse()),
    focus: vi.fn(async () => successResponse()),
    blur: vi.fn(async () => successResponse()),
    selectOption: vi.fn(async () => successResponse()),
    highlight: vi.fn(async () => successResponse()),
    ...overrides,
  } as unknown as PilotGrpcClient
}

// ─── doubleTap() ───

describe('Device.doubleTap()', () => {
  it('delegates to client.doubleTap with selector and default timeout', async () => {
    const doubleTap = vi.fn(async () => successResponse())
    const client = makeMockClient({ doubleTap })
    const device = new Device(client)
    const sel = text('Button')
    await device.doubleTap(sel)
    expect(doubleTap).toHaveBeenCalledWith(sel, 30_000)
  })

  it('throws on failure', async () => {
    const client = makeMockClient({
      doubleTap: vi.fn(async () => failureResponse('Not found')),
    })
    const device = new Device(client)
    await expect(device.doubleTap(text('X'))).rejects.toThrow('Not found')
  })

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      doubleTap: vi.fn(async () => failureResponse('')),
    })
    const device = new Device(client)
    await expect(device.doubleTap(text('X'))).rejects.toThrow('Double tap failed')
  })
})

// ─── drag() ───

describe('Device.drag()', () => {
  it('delegates to client.dragAndDrop with from/to selectors', async () => {
    const dragAndDrop = vi.fn(async () => successResponse())
    const client = makeMockClient({ dragAndDrop })
    const device = new Device(client)
    const from = text('Item')
    const to = text('Zone')
    await device.drag({ from, to })
    expect(dragAndDrop).toHaveBeenCalledWith(from, to, 30_000)
  })

  it('throws on failure', async () => {
    const client = makeMockClient({
      dragAndDrop: vi.fn(async () => failureResponse('')),
    })
    const device = new Device(client)
    await expect(device.drag({ from: text('A'), to: text('B') })).rejects.toThrow('Drag and drop failed')
  })
})

// ─── pinchIn() / pinchOut() ───

describe('Device.pinchIn()', () => {
  it('delegates to client.pinchZoom with default scale 0.5', async () => {
    const pinchZoom = vi.fn(async () => successResponse())
    const client = makeMockClient({ pinchZoom })
    const device = new Device(client)
    const sel = text('Map')
    await device.pinchIn(sel)
    expect(pinchZoom).toHaveBeenCalledWith(sel, 0.5, 30_000)
  })

  it('accepts custom scale', async () => {
    const pinchZoom = vi.fn(async () => successResponse())
    const client = makeMockClient({ pinchZoom })
    const device = new Device(client)
    const sel = text('Map')
    await device.pinchIn(sel, { scale: 0.3 })
    expect(pinchZoom).toHaveBeenCalledWith(sel, 0.3, 30_000)
  })

  it('throws on failure', async () => {
    const client = makeMockClient({
      pinchZoom: vi.fn(async () => failureResponse('')),
    })
    const device = new Device(client)
    await expect(device.pinchIn(text('X'))).rejects.toThrow('Pinch in failed')
  })
})

describe('Device.pinchOut()', () => {
  it('delegates to client.pinchZoom with default scale 2.0', async () => {
    const pinchZoom = vi.fn(async () => successResponse())
    const client = makeMockClient({ pinchZoom })
    const device = new Device(client)
    const sel = text('Map')
    await device.pinchOut(sel)
    expect(pinchZoom).toHaveBeenCalledWith(sel, 2.0, 30_000)
  })

  it('accepts custom scale', async () => {
    const pinchZoom = vi.fn(async () => successResponse())
    const client = makeMockClient({ pinchZoom })
    const device = new Device(client)
    const sel = text('Map')
    await device.pinchOut(sel, { scale: 3.0 })
    expect(pinchZoom).toHaveBeenCalledWith(sel, 3.0, 30_000)
  })

  it('throws on failure', async () => {
    const client = makeMockClient({
      pinchZoom: vi.fn(async () => failureResponse('')),
    })
    const device = new Device(client)
    await expect(device.pinchOut(text('X'))).rejects.toThrow('Pinch out failed')
  })
})

// ─── focus() / blur() ───

describe('Device.focus()', () => {
  it('delegates to client.focus', async () => {
    const focus = vi.fn(async () => successResponse())
    const client = makeMockClient({ focus })
    const device = new Device(client)
    const sel = role('textfield')
    await device.focus(sel)
    expect(focus).toHaveBeenCalledWith(sel, 30_000)
  })

  it('throws on failure', async () => {
    const client = makeMockClient({
      focus: vi.fn(async () => failureResponse('')),
    })
    const device = new Device(client)
    await expect(device.focus(text('X'))).rejects.toThrow('Focus failed')
  })
})

describe('Device.blur()', () => {
  it('delegates to client.blur', async () => {
    const blur = vi.fn(async () => successResponse())
    const client = makeMockClient({ blur })
    const device = new Device(client)
    const sel = role('textfield')
    await device.blur(sel)
    expect(blur).toHaveBeenCalledWith(sel, 30_000)
  })

  it('throws on failure', async () => {
    const client = makeMockClient({
      blur: vi.fn(async () => failureResponse('')),
    })
    const device = new Device(client)
    await expect(device.blur(text('X'))).rejects.toThrow('Blur failed')
  })
})

// ─── selectOption() ───

describe('Device.selectOption()', () => {
  it('delegates to client.selectOption with string', async () => {
    const selectOption = vi.fn(async () => successResponse())
    const client = makeMockClient({ selectOption })
    const device = new Device(client)
    const sel = role('combobox')
    await device.selectOption(sel, 'Option 2')
    expect(selectOption).toHaveBeenCalledWith(sel, 'Option 2', 30_000)
  })

  it('delegates to client.selectOption with index', async () => {
    const selectOption = vi.fn(async () => successResponse())
    const client = makeMockClient({ selectOption })
    const device = new Device(client)
    const sel = role('combobox')
    await device.selectOption(sel, { index: 1 })
    expect(selectOption).toHaveBeenCalledWith(sel, { index: 1 }, 30_000)
  })

  it('throws on failure', async () => {
    const client = makeMockClient({
      selectOption: vi.fn(async () => failureResponse('')),
    })
    const device = new Device(client)
    await expect(device.selectOption(text('X'), 'A')).rejects.toThrow('Select option failed')
  })
})

// ─── highlight() ───

describe('Device.highlight()', () => {
  it('delegates to client.highlight', async () => {
    const highlight = vi.fn(async () => successResponse())
    const client = makeMockClient({ highlight })
    const device = new Device(client)
    const sel = text('Submit')
    await device.highlight(sel)
    expect(highlight).toHaveBeenCalledWith(sel, undefined, 30_000)
  })

  it('passes durationMs option', async () => {
    const highlight = vi.fn(async () => successResponse())
    const client = makeMockClient({ highlight })
    const device = new Device(client)
    const sel = text('Submit')
    await device.highlight(sel, { durationMs: 2000 })
    expect(highlight).toHaveBeenCalledWith(sel, 2000, 30_000)
  })

  it('throws on failure', async () => {
    const client = makeMockClient({
      highlight: vi.fn(async () => failureResponse('')),
    })
    const device = new Device(client)
    await expect(device.highlight(text('X'))).rejects.toThrow('Highlight failed')
  })
})
