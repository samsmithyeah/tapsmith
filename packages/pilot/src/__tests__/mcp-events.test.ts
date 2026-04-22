import { describe, it, expect } from 'vitest';
import { summarizeResult, nextCallId } from '../mcp/events.js';

describe('summarizeResult()', () => {
  it('summarizes snapshot with element and selector counts', () => {
    const result = '- [1] Button "Login"\n- [2] TextField\n\n## Suggested Selectors\ndevice.getByRole("button")\ndevice.getByText("Login")';
    expect(summarizeResult('pilot_snapshot', result)).toBe('2 elements, 2 selectors');
  });

  it('returns "PNG image captured" for screenshot', () => {
    expect(summarizeResult('pilot_screenshot', '')).toBe('PNG image captured');
  });

  it('summarizes test_selector match', () => {
    const result = JSON.stringify({ matched: true, count: 3, elements: [] });
    expect(summarizeResult('pilot_test_selector', result)).toBe('matched 3 elements');
  });

  it('summarizes test_selector no match', () => {
    const result = JSON.stringify({ matched: false, count: 0, elements: [] });
    expect(summarizeResult('pilot_test_selector', result)).toBe('no match');
  });

  it('summarizes list_devices', () => {
    const result = JSON.stringify([{ serial: 'emulator-5554' }, { serial: 'abc123' }]);
    expect(summarizeResult('pilot_list_devices', result)).toBe('2 devices');
  });

  it('summarizes run_tests with pass and fail counts', () => {
    expect(summarizeResult('pilot_run_tests', 'Tests failed: 3 passed, 1 failed, 0 skipped'))
      .toBe('3 passed, 1 failed');
  });

  it('summarizes run_tests all passed', () => {
    expect(summarizeResult('pilot_run_tests', 'All tests passed: 5 passed, 0 skipped (1234ms)'))
      .toBe('5 passed');
  });

  it('returns "OK" for successful device actions', () => {
    for (const tool of ['pilot_tap', 'pilot_type', 'pilot_swipe', 'pilot_press_key', 'pilot_launch_app']) {
      expect(summarizeResult(tool, 'OK')).toBe('OK');
    }
  });

  it('summarizes read_trace step count', () => {
    expect(summarizeResult('pilot_read_trace', '## Steps (12 events)\n...')).toBe('## Steps (12 events)');
  });

  it('summarizes list_tests file count', () => {
    expect(summarizeResult('pilot_list_tests', '25 test file(s):\n/path/to/test.ts')).toBe('25 test file');
  });

  it('summarizes list_results', () => {
    expect(summarizeResult('pilot_list_results', 'Results: 10 passed, 2 failed, 1 skipped (13 total)'))
      .toBe('10 passed, 2 failed, 1 skipped');
  });

  it('summarizes stop_tests', () => {
    expect(summarizeResult('pilot_stop_tests', 'Stop signal sent. The running test will be terminated.'))
      .toBe('stopped');
    expect(summarizeResult('pilot_stop_tests', 'No test run is currently in progress.'))
      .toBe('nothing running');
  });

  it('summarizes session_info', () => {
    expect(summarizeResult('pilot_session_info', '## Session\nDevice: ...')).toBe('session info');
  });

  it('summarizes watch toggle', () => {
    expect(summarizeResult('pilot_watch', 'Watch enabled for file [android]. Will re-run on save.'))
      .toBe('watch enabled');
    expect(summarizeResult('pilot_watch', 'Watch disabled for file [android].'))
      .toBe('watch disabled');
  });

  it('truncates unknown tools to 60 chars', () => {
    const long = 'a'.repeat(100);
    expect(summarizeResult('unknown_tool', long)).toBe('a'.repeat(60));
  });
});

describe('nextCallId()', () => {
  it('returns unique IDs', () => {
    const a = nextCallId();
    const b = nextCallId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^mcp-\d+-\d+$/);
  });
});
