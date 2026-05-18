import * as path from 'node:path';
import * as readline from 'node:readline';
import type { ChildProcess, ForkOptions } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { TapsmithConfig } from './config.js';
import type { ResolvedProject } from './project.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

export type LaunchStepId =
  | 'config'
  | 'worker-plan'
  | 'primary-device'
  | 'daemon'
  | 'app-install'
  | 'agent'
  | 'app-launch'
  | 'worker-devices'
  | 'ui-server'
  | 'mcp'
  | 'test-tree'
  | 'ui-workers'
  | 'browser';

export type LaunchStepState = 'pending' | 'running' | 'done' | 'warning' | 'failed' | 'skipped';

export interface LaunchStepProgress {
  done: number
  total: number
}

export interface LaunchStep {
  id: LaunchStepId
  label: string
  state: LaunchStepState
  detail: string
  progress?: LaunchStepProgress
}

export interface LaunchProgressSink {
  start(id: LaunchStepId, detail?: string): void
  complete(id: LaunchStepId, detail?: string): void
  fail(id: LaunchStepId, detail?: string): void
  skip(id: LaunchStepId, detail?: string): void
  update(id: LaunchStepId, patch: Partial<Pick<LaunchStep, 'state' | 'detail' | 'progress'>>): void
  note(message: string): void
  finish(detail?: string): void
}

export function forkStdioForLaunchProgress(progress?: LaunchProgressSink): ForkOptions['stdio'] {
  return progress ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'inherit', 'inherit', 'ipc'];
}

export function pipeForkOutputForLaunchProgress(child: ChildProcess, progress?: LaunchProgressSink): void {
  if (!progress) return;
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
}

interface LaunchProgressStream extends Writable {
  columns?: number
  isTTY?: boolean
}

type WriteMethod = typeof process.stdout.write;

export interface UiLaunchPlanInput {
  config: TapsmithConfig
  testFileCount: number
  workerCount: number
  mode?: 'ui' | 'test'
  projects?: ResolvedProject[]
  workerPlanWarning?: string
}

export interface UiLaunchProgressOptions {
  stream?: LaunchProgressStream
  forceInteractive?: boolean
  color?: boolean
  title?: string
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function basenameMaybe(value: string | undefined): string | undefined {
  return value ? path.basename(value) : undefined;
}

function platformSummary(config: TapsmithConfig, projects?: ResolvedProject[]): string {
  const platforms = new Set<string>();
  if (projects && projects.length > 0) {
    for (const project of projects) {
      platforms.add(project.effectiveConfig.platform ?? 'android');
    }
  } else {
    platforms.add(config.platform ?? 'android');
  }
  return [...platforms].sort().join(' + ');
}

function describeDeviceTarget(config: TapsmithConfig): string {
  if (config.platform === 'ios') {
    if (config.device) return `use iOS device ${config.device}`;
    if (config.simulator) return `select or boot iOS simulator "${config.simulator}"`;
    return 'auto-detect paired physical iOS device';
  }
  if (config.device) return `use Android device ${config.device}`;
  if (config.launchEmulators && config.avd) return `select or launch Android AVD "${config.avd}"`;
  if (config.launchEmulators) return 'select or launch Android emulator';
  return 'select connected Android device';
}

function describeAppInstall(config: TapsmithConfig): string {
  const artifact = basenameMaybe(config.platform === 'ios' ? config.app : config.apk);
  if (artifact) return `verify/install ${artifact}`;
  if (config.package) return `no install artifact; validate ${config.package}`;
  return 'no app package configured';
}

function describeAgent(config: TapsmithConfig): string {
  if (config.platform === 'ios') {
    const xctestrun = basenameMaybe(config.iosXctestrun);
    return xctestrun ? `start iOS agent from ${xctestrun}` : 'resolve xctestrun and start iOS agent';
  }
  return 'start Android automation agent';
}

function describeWorkerDevices(input: UiLaunchPlanInput): string {
  if (input.workerCount <= 1) return 'single device session';
  const bucketCount = new Set(input.projects?.map((p) => p.deviceSignature) ?? [input.config.platform ?? 'android']).size;
  if (bucketCount > 1) {
    return `prepare ${plural(input.workerCount, 'device')} across ${plural(bucketCount, 'target')}`;
  }
  return `prepare ${plural(input.workerCount, 'device')}`;
}

export function createUiLaunchSteps(input: UiLaunchPlanInput): LaunchStep[] {
  const mode = input.mode ?? 'ui';
  const projectCount = input.projects?.filter((p) => p.name !== 'default').length ?? 0;
  const configDetail = [
    plural(input.workerCount, 'worker'),
    plural(input.testFileCount, 'test file'),
    platformSummary(input.config, input.projects),
    projectCount > 0 ? plural(projectCount, 'project') : undefined,
  ].filter(Boolean).join(' | ');

  const steps: LaunchStep[] = [
    { id: 'config', label: 'Config', state: 'done', detail: configDetail },
  ];

  if (input.workerPlanWarning) {
    steps.push({
      id: 'worker-plan',
      label: 'Worker plan',
      state: 'warning',
      detail: input.workerPlanWarning,
    });
  }

  if (mode === 'test' && input.workerCount > 1) {
    steps.push(
      {
        id: 'daemon',
        label: 'Worker daemons',
        state: 'pending',
        detail: `start ${plural(input.workerCount, 'worker daemon')}`,
        progress: { done: 0, total: input.workerCount },
      },
      { id: 'worker-devices', label: 'Worker devices', state: 'pending', detail: describeWorkerDevices(input) },
      {
        id: 'app-install',
        label: 'App install',
        state: 'pending',
        detail: `verify app on ${plural(input.workerCount, 'device')}`,
        progress: { done: 0, total: input.workerCount },
      },
      {
        id: 'agent',
        label: 'Agents',
        state: 'pending',
        detail: `start ${plural(input.workerCount, 'automation agent')}`,
        progress: { done: 0, total: input.workerCount },
      },
      {
        id: 'app-launch',
        label: 'App launch',
        state: 'pending',
        detail: input.config.package
          ? `launch ${input.config.package} on ${plural(input.workerCount, 'device')}`
          : 'validate worker sessions',
        progress: { done: 0, total: input.workerCount },
      },
      {
        id: 'ui-workers',
        label: 'Workers',
        state: 'pending',
        detail: `start ${plural(input.workerCount, 'worker')}`,
        progress: { done: 0, total: input.workerCount },
      },
    );
  } else if (mode === 'ui' || input.workerCount <= 1) {
    steps.push(
      { id: 'primary-device', label: 'Primary device', state: 'pending', detail: describeDeviceTarget(input.config) },
      { id: 'daemon', label: 'Daemon', state: 'pending', detail: `start tapsmith-core on ${input.config.daemonAddress}` },
      { id: 'app-install', label: 'App install', state: 'pending', detail: describeAppInstall(input.config) },
      { id: 'agent', label: 'Agent', state: 'pending', detail: describeAgent(input.config) },
      { id: 'app-launch', label: 'App launch', state: 'pending', detail: input.config.package ? `launch ${input.config.package}` : 'no package configured' },
    );
  }

  if (mode === 'ui' && input.workerCount > 1) {
    steps.push(
      { id: 'worker-devices', label: 'Worker devices', state: 'pending', detail: describeWorkerDevices(input) },
      {
        id: 'ui-workers',
        label: mode === 'ui' ? 'UI workers' : 'Workers',
        state: 'pending',
        detail: `start ${plural(input.workerCount, 'worker')}`,
        progress: { done: 0, total: input.workerCount },
      },
    );
  }

  if (mode === 'ui') {
    steps.push(
      { id: 'ui-server', label: 'UI server', state: 'pending', detail: 'bind local web UI' },
      { id: 'mcp', label: 'MCP server', state: 'pending', detail: 'bind MCP endpoint' },
      { id: 'test-tree', label: 'Test tree', state: 'pending', detail: `discover ${plural(input.testFileCount, 'file')} for the UI` },
      { id: 'browser', label: 'Browser', state: 'pending', detail: 'open UI mode' },
    );
  }

  return steps;
}

function statusRaw(step: LaunchStep): string {
  if (step.progress && (step.state === 'running' || step.state === 'done' || step.state === 'warning')) {
    if (step.state === 'done' && step.progress.done >= step.progress.total) return '✓';
    return `${step.progress.done}/${step.progress.total}`;
  }
  switch (step.state) {
    case 'done': return '✓';
    case 'warning': return '!';
    case 'failed': return '✗';
    case 'skipped': return '○';
    case 'running': return '…';
    case 'pending': return '·';
  }
}

function colorStatus(state: LaunchStepState, raw: string, color: boolean): string {
  if (!color) return raw;
  switch (state) {
    case 'done': return `${GREEN}${raw}${RESET}`;
    case 'warning': return `${YELLOW}${raw}${RESET}`;
    case 'failed': return `${RED}${raw}${RESET}`;
    case 'skipped': return `${DIM}${raw}${RESET}`;
    case 'running': return `${CYAN}${raw}${RESET}`;
    case 'pending': return `${DIM}${raw}${RESET}`;
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function padVisible(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  return s + ' '.repeat(Math.max(0, width - visible));
}

function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  if (width === 1) return '…';
  return `${s.slice(0, width - 1)}…`;
}

export function formatLaunchTable(
  steps: LaunchStep[],
  opts: { columns?: number; color?: boolean; title?: string } = {},
): string {
  const color = opts.color ?? true;
  // Keep one column of slack so terminals do not auto-wrap the last cell and
  // invalidate the cursor math used for live in-place updates.
  const columns = Math.max(48, (opts.columns ?? 80) - 1);
  const headers = ['STEP', 'STATUS', 'DETAILS'];
  const rawRows = steps.map((step) => [step.label, statusRaw(step), step.detail]);
  const stepWidth = Math.max(headers[0].length, ...rawRows.map((r) => r[0].length));
  const statusWidth = Math.max(headers[1].length, ...rawRows.map((r) => r[1].length));
  const detailWidth = Math.max(12, columns - stepWidth - statusWidth - 6);

  const header = [
    color ? `${BOLD}${padVisible(headers[0], stepWidth)}${RESET}` : padVisible(headers[0], stepWidth),
    color ? `${BOLD}${padVisible(headers[1], statusWidth)}${RESET}` : padVisible(headers[1], statusWidth),
    color ? `${BOLD}${headers[2]}${RESET}` : headers[2],
  ].join('  ');
  const separatorRaw = ['─'.repeat(stepWidth), '─'.repeat(statusWidth), '─'.repeat(detailWidth)].join('  ');
  const separator = color ? `${DIM}${separatorRaw}${RESET}` : separatorRaw;

  const body = steps.map((step) => {
    const status = colorStatus(step.state, statusRaw(step), color);
    return [
      padVisible(step.label, stepWidth),
      padVisible(status, statusWidth),
      truncate(step.detail, detailWidth),
    ].join('  ');
  });

  const title = opts.title ?? 'Preparing UI mode';
  const titleLine = color ? `${BOLD}${title}${RESET}` : title;
  return [titleLine, header, separator, ...body].join('\n');
}

function countTerminalRows(text: string, columns: number | undefined): number {
  const width = Math.max(1, (columns ?? 80) - 1);
  return text.split('\n').reduce((sum, line) => {
    const visible = stripAnsi(line).length;
    return sum + Math.max(1, Math.ceil(visible / width));
  }, 0);
}

export class UiLaunchProgress implements LaunchProgressSink {
  private readonly steps: LaunchStep[];
  private readonly byId: Map<LaunchStepId, LaunchStep>;
  private readonly stream: LaunchProgressStream;
  private readonly interactive: boolean;
  private readonly color: boolean;
  private readonly title: string;
  private renderedLineCount = 0;
  private nonInteractiveSnapshots = new Map<LaunchStepId, string>();
  private originalStdoutWrite?: WriteMethod;
  private originalStderrWrite?: WriteMethod;
  private internalWriteDepth = 0;
  private finished = false;

  constructor(steps: LaunchStep[], options: UiLaunchProgressOptions = {}) {
    this.steps = steps.map((step) => ({ ...step, progress: step.progress ? { ...step.progress } : undefined }));
    this.byId = new Map(this.steps.map((step) => [step.id, step]));
    this.stream = options.stream ?? process.stdout;
    this.interactive = options.forceInteractive ?? Boolean(this.stream.isTTY && !process.env.CI);
    this.color = options.color ?? Boolean(this.stream.isTTY);
    this.title = options.title ?? 'Preparing UI mode';
    this.installWriteInterceptors();
    this.render();
  }

  start(id: LaunchStepId, detail?: string): void {
    this.update(id, { state: 'running', detail });
  }

  complete(id: LaunchStepId, detail?: string): void {
    const step = this.byId.get(id);
    const progress = step?.progress ? { ...step.progress, done: step.progress.total } : undefined;
    this.update(id, { state: 'done', detail, progress });
  }

  fail(id: LaunchStepId, detail?: string): void {
    this.update(id, { state: 'failed', detail });
  }

  skip(id: LaunchStepId, detail?: string): void {
    this.update(id, { state: 'skipped', detail });
  }

  update(id: LaunchStepId, patch: Partial<Pick<LaunchStep, 'state' | 'detail' | 'progress'>>): void {
    if (this.finished) return;
    const step = this.byId.get(id);
    if (!step) return;
    if (patch.state) step.state = patch.state;
    if (patch.detail !== undefined) step.detail = patch.detail;
    if (patch.progress) step.progress = { ...patch.progress };
    this.render();
  }

  note(message: string): void {
    if (this.finished) return;
    this.clearRendered();
    this.write(`${DIM}${message}${RESET}\n`);
    this.render();
  }

  finish(detail?: string): void {
    if (this.finished) return;
    if (detail) this.complete('browser', detail);
    if (this.interactive) {
      this.clearRendered();
      this.writeInteractiveTable();
      this.write('\n');
      this.renderedLineCount = 0;
    } else {
      this.render();
    }
    this.restoreWriteInterceptors();
    this.finished = true;
  }

  private render(): void {
    if (this.interactive) {
      this.clearRendered();
      this.writeInteractiveTable();
      return;
    }

    if (this.nonInteractiveSnapshots.size === 0) {
      this.write(`${formatLaunchTable(this.steps, { color: this.color, title: this.title })}\n`);
      for (const step of this.steps) {
        this.nonInteractiveSnapshots.set(step.id, `${step.state}|${step.detail}|${statusRaw(step)}`);
      }
      return;
    }

    for (const step of this.steps) {
      const snapshot = `${step.state}|${step.detail}|${statusRaw(step)}`;
      if (this.nonInteractiveSnapshots.get(step.id) === snapshot) continue;
      this.nonInteractiveSnapshots.set(step.id, snapshot);
      if (step.state === 'pending') continue;
      const status = colorStatus(step.state, statusRaw(step), this.color);
      this.write(`${padVisible(status, 5)} ${step.label}: ${step.detail}\n`);
    }
  }

  private clearRendered(): void {
    if (!this.interactive || this.renderedLineCount <= 0) return;
    this.withInternalWrite(() => {
      readline.cursorTo(this.stream, 0);
      readline.moveCursor(this.stream, 0, -this.renderedLineCount);
      readline.clearScreenDown(this.stream);
    });
    this.renderedLineCount = 0;
  }

  private writeInteractiveTable(): void {
    const table = formatLaunchTable(this.steps, {
      columns: this.stream.columns,
      color: this.color,
      title: this.title,
    });
    this.write(`${table}\n`);
    this.renderedLineCount = countTerminalRows(table, this.stream.columns);
  }

  private installWriteInterceptors(): void {
    if (!this.interactive || this.stream !== process.stdout) return;
    this.originalStdoutWrite = process.stdout.write;
    this.originalStderrWrite = process.stderr.write;
    process.stdout.write = this.createExternalWriteInterceptor(process.stdout, this.originalStdoutWrite) as WriteMethod;
    process.stderr.write = this.createExternalWriteInterceptor(process.stderr, this.originalStderrWrite) as WriteMethod;
  }

  private restoreWriteInterceptors(): void {
    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
      this.originalStdoutWrite = undefined;
    }
    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite;
      this.originalStderrWrite = undefined;
    }
  }

  private createExternalWriteInterceptor(stream: NodeJS.WriteStream, originalWrite: WriteMethod): WriteMethod {
    const original = originalWrite.bind(stream);
    return ((...args: Parameters<WriteMethod>): ReturnType<WriteMethod> => {
      if (this.internalWriteDepth > 0 || this.finished || this.renderedLineCount <= 0) {
        return original(...args);
      }

      this.clearRendered();
      const result = original(...args);
      this.writeInteractiveTable();
      return result;
    }) as WriteMethod;
  }

  private write(chunk: string): void {
    this.withInternalWrite(() => {
      this.stream.write(chunk);
    });
  }

  private withInternalWrite<T>(fn: () => T): T {
    this.internalWriteDepth++;
    try {
      return fn();
    } finally {
      this.internalWriteDepth--;
    }
  }
}
