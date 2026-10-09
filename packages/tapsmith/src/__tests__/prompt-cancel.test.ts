import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import Enquirer from 'enquirer';
import { isPromptCancel, tolerateClosedReadline } from '../prompt-cancel.js';

// Ctrl-C at an enquirer prompt (PILOT-518). Node's readline closes its own
// interface on Ctrl-C before enquirer's cancel runs, and on Node 24
// enquirer's cleanup then throws ERR_USE_AFTER_CLOSE out of cancel(): the
// prompt never settles and the process crashes with a stack trace.

interface RunResult { settled: 'resolved' | 'rejected' | 'pending'; reason?: unknown; rawMode: boolean }

/** Runs a real enquirer prompt on a fake TTY, presses `key` once it is shown, and reports how the prompt ended. */
async function press(type: 'Select' | 'Input' | 'Confirm', key: string, guard: boolean): Promise<RunResult> {
  let rawMode = false;
  // enquirer only listens to a TTY: a PassThrough dressed as one.
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: (on: boolean) => { rawMode = on; return stdin; },
  });
  const stdout = new PassThrough();
  stdout.resume();
  const options = {
    name: 'q',
    message: 'Which platform(s) will you test?',
    choices: type === 'Select' ? ['Android', 'iOS', 'Both'] : undefined,
    stdin,
    stdout,
    ...(guard ? { onRun: tolerateClosedReadline } : {}),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- enquirer's prompt classes are untyped statics
  const prompt = new (Enquirer as any)[type](options);
  prompt.once('run', () => { stdin.write(key); });

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const outcome = await Promise.race([
      (prompt.run() as Promise<unknown>).then(
        () => ({ settled: 'resolved' as const }),
        (reason: unknown) => ({ settled: 'rejected' as const, reason }),
      ),
      new Promise<{ settled: 'pending' }>((resolve) => setTimeout(() => resolve({ settled: 'pending' }), 2000)),
    ]);
    if (unhandled.length > 0) throw unhandled[0];
    return { ...outcome, rawMode };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0]);

describe('tolerateClosedReadline()', () => {
  for (const type of ['Select', 'Input', 'Confirm'] as const) {
    it(`lets Ctrl-C cancel a ${type} prompt: it rejects as cancelled and restores the terminal`, async () => {
      const result = await press(type, '\x03', true);
      expect(result.settled).toBe('rejected');
      expect(isPromptCancel(result.reason)).toBe(true);
      expect(result.rawMode).toBe(false);
    });
  }

  it('still lets Esc cancel', async () => {
    const result = await press('Select', '\x1b', true);
    expect(result.settled).toBe('rejected');
    expect(isPromptCancel(result.reason)).toBe(true);
  });

  it('leaves a normal answer alone', async () => {
    const result = await press('Select', '\r', true);
    expect(result.settled).toBe('resolved');
  });

  // Pins the enquirer + Node behaviour the guard exists for, so an enquirer
  // or Node upgrade that fixes it shows up here.
  it.runIf(nodeMajor >= 24)('is needed: unguarded, Ctrl-C throws ERR_USE_AFTER_CLOSE out of the prompt on Node 24', async () => {
    await expect(press('Select', '\x03', false)).rejects.toMatchObject({ code: 'ERR_USE_AFTER_CLOSE' });
  });

  it('rethrows any other error from closing the prompt', async () => {
    const boom = Object.assign(new Error('boom'), { code: 'EIO' });
    const prompt = { close: (): Promise<void> => Promise.reject(boom) };
    tolerateClosedReadline(prompt);
    await expect(prompt.close()).rejects.toBe(boom);
  });

  it('swallows ERR_USE_AFTER_CLOSE from closing the prompt', async () => {
    const closed = Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    const prompt = { close: (): Promise<void> => Promise.reject(closed) };
    tolerateClosedReadline(prompt);
    await expect(prompt.close()).resolves.toBeUndefined();
  });
});

describe('isPromptCancel()', () => {
  it('recognises enquirer\'s cancel rejection, and nothing else', () => {
    expect(isPromptCancel('')).toBe(true);
    expect(isPromptCancel(new Error(''))).toBe(true);
    expect(isPromptCancel(new Error('boom'))).toBe(false);
    expect(isPromptCancel('boom')).toBe(false);
    expect(isPromptCancel(undefined)).toBe(false);
  });
});
