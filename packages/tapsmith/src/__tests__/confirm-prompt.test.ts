import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import Enquirer from 'enquirer';
import { confirmQuestion } from '../confirm-prompt.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Runs a real enquirer confirm prompt, answers it with `key` (Enter for the default), and returns what it rendered. */
async function render(initial: boolean, key: string): Promise<{ value: boolean; pending: string; final: string }> {
  // enquirer only listens to a TTY: a PassThrough dressed as one.
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => stdin });
  const stdout = new PassThrough();
  const frames: string[] = [];
  stdout.on('data', (d: Buffer) => frames.push(stripAnsi(d.toString())));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- enquirer's prompt classes are untyped statics
  const Confirm = (Enquirer as any).Confirm;
  const prompt = new Confirm({ ...confirmQuestion('Generate example test file?', initial), name: 'q', stdin, stdout });
  let pending = '';
  prompt.once('run', () => {
    pending = frames.join('');
    frames.length = 0;
    stdin.write(key);
  });
  const value = await prompt.run() as boolean;
  return { value, pending, final: frames.join('') };
}

describe('confirmQuestion()', () => {
  it('renders the answer as yes/no, never as the boolean', async () => {
    const yes = await render(true, '\r');
    expect(yes.value).toBe(true);
    // enquirer's separator glyphs differ by platform (`›`/`‣` pending, `·` answered), so match any.
    expect(yes.final).toMatch(/Generate example test file\? \(Y\/n\) \S yes/);
    expect(yes.final).not.toMatch(/true|false/);

    const no = await render(true, 'n');
    expect(no.value).toBe(false);
    expect(no.final).toMatch(/\(Y\/n\) \S no/);
    expect(no.final).not.toMatch(/true|false/);
  });

  it('shows no answer when cancelled with Ctrl-C', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: () => stdin });
    const stdout = new PassThrough();
    const frames: string[] = [];
    stdout.on('data', (d: Buffer) => frames.push(stripAnsi(d.toString())));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- enquirer's prompt classes are untyped statics
    const prompt = new (Enquirer as any).Confirm({ ...confirmQuestion('Install it now?', true), name: 'q', stdin, stdout });
    prompt.once('run', () => {
      frames.length = 0;
      // What enquirer's ctrl+c action calls.
      void prompt.cancel();
    });
    await expect(prompt.run()).rejects.toBeDefined();
    expect(frames.join('')).toMatch(/Install it now\? \(Y\/n\)/);
    expect(frames.join('')).not.toMatch(/\b(yes|no|true|false)\b/);
  });

  it('shows no value while waiting for an answer: the (Y/n) hint is the default', async () => {
    const { pending } = await render(false, '\r');
    expect(pending).toMatch(/Generate example test file\? \(y\/N\) \S\s*$/);
    expect(pending).not.toMatch(/\b(yes|no|true|false)\b/);
  });
});
