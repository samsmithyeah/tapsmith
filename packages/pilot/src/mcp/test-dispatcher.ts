export interface TestRunResult {
  status: 'passed' | 'failed'
  passed: number
  failed: number
  skipped: number
  duration: number
}

export interface TestResultEntry {
  fullName: string
  filePath: string
  status: 'passed' | 'failed' | 'skipped' | 'idle' | 'running'
  duration?: number
  error?: string
  tracePath?: string
  projectName?: string
}

export interface TestDispatcher {
  runFiles(files: string[], options?: { testFilter?: string; project?: string }): Promise<TestRunResult>
  runAll(): Promise<TestRunResult>
  stop(): void
  isRunning(): boolean
  getResults(): TestResultEntry[]
  getTestFiles(): string[]
  getProjects(): string[]
}
