// Minimal test harness that imports our compiled Pilot SDK and runs the example tests
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { register } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pilotDist = resolve(__dirname, '../../packages/pilot/dist');

// We'll manually import and execute since the tests import from "pilot"
// Let's create a simulated run using the actual SDK classes

const { PilotGrpcClient } = await import(resolve(pilotDist, 'grpc-client.js'));
const { Device } = await import(resolve(pilotDist, 'device.js'));
const selectors = await import(resolve(pilotDist, 'selectors.js'));
const { expect } = await import(resolve(pilotDist, 'expect.js'));

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';

// Connect to daemon
console.log(`${CYAN}Connecting to Pilot daemon...${RESET}`);
const client = new PilotGrpcClient('localhost:50051');
const ready = await client.waitForReady(5000);
if (!ready) {
  console.error(`${RED}Failed to connect to daemon${RESET}`);
  process.exit(1);
}
const pong = await client.ping();
console.log(`${DIM}Connected to Pilot daemon v${pong.version} (agent: ${pong.agentConnected ? 'connected' : 'not connected'})${RESET}`);

const device = new Device(client, { timeout: 15000 });

// Connect to the on-device agent
console.log(`${DIM}Connecting to on-device agent...${RESET}`);
try {
  await device.startAgent('com.samlovesit.StoryApp');
  console.log(`${DIM}Agent connected.${RESET}`);
} catch (e) {
  console.error(`${RED}Failed to connect to agent: ${e.message}${RESET}`);
  console.error(`${DIM}Make sure the agent is running: adb shell am instrument -w dev.pilot.agent/dev.pilot.agent.PilotAgent${RESET}`);
  process.exit(1);
}

// Test runner
let passed = 0, failed = 0;
const startTime = Date.now();

async function runTest(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    console.log(`  ${GREEN}PASS${RESET}  ${name} ${DIM}(${ms}ms)${RESET}`);
    passed++;
  } catch (err) {
    const ms = Date.now() - t0;
    console.log(`  ${RED}FAIL${RESET}  ${name} ${DIM}(${ms}ms)${RESET}`);
    console.log(`        ${RED}${err.message}${RESET}`);
    failed++;
  }
}

// ─── Library Screen Tests ───
console.log(`\n${BOLD}Library screen${RESET}`);

await runTest('shows the app header and tagline', async () => {
  await expect(device.element(selectors.text('DreamSpinner'))).toBeVisible({ timeout: 10000 });
  await expect(device.element(selectors.text('Unleash endless creativity'))).toBeVisible();
});

await runTest('displays LIBRARY section heading', async () => {
  await expect(device.element(selectors.text('LIBRARY'))).toBeVisible();
});

await runTest('shows story cards in the library', async () => {
  await expect(device.element(selectors.text('The Kebab at the End of Everything'))).toBeVisible();
  await expect(device.element(selectors.text('The Butterflies That Vanished'))).toBeVisible();
});

await runTest('Create story button is visible', async () => {
  await expect(device.element(selectors.contentDesc('Create story'))).toBeVisible();
});

// ─── Navigation Tests ───
console.log(`\n${BOLD}Bottom navigation${RESET}`);

await runTest('can navigate to Settings tab', async () => {
  await device.tap(selectors.text('Settings'));
  await expect(device.element(selectors.text('Child profiles'))).toBeVisible({ timeout: 10000 });
});

await runTest('can navigate to Credits tab', async () => {
  await device.tap(selectors.text('Credits'));
  await expect(device.element(selectors.text('Credit packs'))).toBeVisible({ timeout: 10000 });
});

await runTest('can navigate back to Library', async () => {
  await device.tap(selectors.text('Library'));
  await expect(device.element(selectors.text('LIBRARY'))).toBeVisible({ timeout: 10000 });
});

// ─── Story Interaction Tests ───
console.log(`\n${BOLD}Story interaction${RESET}`);

await runTest('can open a story detail', async () => {
  await device.tap(selectors.text('The Kebab at the End of Everything'));
  await expect(device.element(selectors.text('Start reading'))).toBeVisible({ timeout: 10000 });
});

await runTest('can start reading a story', async () => {
  await device.tap(selectors.text('Start reading'));
  await expect(device.element(selectors.textContains('Page 1 of 6'))).toBeVisible({ timeout: 10000 });
});

await runTest('can swipe to next page', async () => {
  await device.swipe('left', { speed: 2000, distance: 0.7 });
  // Wait a moment for page transition
  await device.waitForIdle(2000);
  await expect(device.element(selectors.textContains('Page 2 of 6'))).toBeVisible({ timeout: 10000 });
});

await runTest('can go back to library from reader', async () => {
  await device.pressBack();
  await expect(device.element(selectors.text('LIBRARY'))).toBeVisible({ timeout: 10000 });
});

// ─── Summary ───
const totalMs = Date.now() - startTime;
console.log(`\n${BOLD}Summary:${RESET} ${GREEN}${passed} passed${RESET}${failed > 0 ? `, ${RED}${failed} failed${RESET}` : ''} ${DIM}| ${(totalMs/1000).toFixed(2)}s${RESET}\n`);

client.close();
process.exit(failed > 0 ? 1 : 0);
