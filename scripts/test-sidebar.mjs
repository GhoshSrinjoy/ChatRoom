import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';

const root = process.cwd();
const legacy = process.argv.includes('--legacy');
const testRoot = resolve(process.env.CHATROOM_TEST_PROFILE || (legacy ? '.conda/chatroom/sidebar-legacy-test' : '.conda/chatroom/sidebar-render-test'));
await mkdir(testRoot, { recursive: true });
const code = join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
const port = 9337;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let extensionPath = process.env.CHATROOM_TEST_EXTENSION || root;
if (legacy) {
  extensionPath = join(testRoot, 'fixture-extension'); await mkdir(extensionPath, { recursive: true });
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  manifest.contributes.views['chatroom-secondary'][0].id = 'chatroom.sidebar';
  await writeFile(join(extensionPath, 'package.json'), JSON.stringify(manifest));
  await cp('dist', join(extensionPath, 'dist'), { recursive: true });
  await cp('media', join(extensionPath, 'media'), { recursive: true });
}
const child = spawn(code, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(testRoot, 'user')}`, `--extensions-dir=${join(testRoot, 'extensions')}`, `--extensionDevelopmentPath=${extensionPath}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', root], { env, windowsHide: true, stdio: 'ignore' });
let browser;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 0; i < 60; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await sleep(500); }
  }
  if (!browser) throw new Error('VS Code debugging endpoint did not start');
  let page;
  for (let i = 0; i < 60; i++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => /workbench/.test(p.url()));
    if (page) break; await sleep(500);
  }
  if (!page) throw new Error('VS Code workbench page not found');
  await page.locator('.monaco-workbench').waitFor({ timeout: 30000 });
  const restored = process.argv.includes('--restore');
  if (!restored) {
    await page.keyboard.press('Control+Shift+P');
    const input = page.locator('.quick-input-widget input').first();
    const command = process.env.CHATROOM_TEST_COMMAND || (legacy ? 'Chatroom' : 'Chatroom: Open Room');
    await input.fill('>' + command);
    const entries = page.locator('.quick-input-list .monaco-list-row');
    await entries.first().waitFor();
    if (legacy) {
      console.log('Legacy view commands:', await page.locator('.quick-input-widget').innerText());
      await entries.filter({ hasText: 'Focus on Chatroom View' }).first().click();
    } else {
      await entries.filter({ hasText: command }).first().waitFor();
      await page.keyboard.press('Enter');
    }
  }
  let frame;
  for (let i = 0; i < 90; i++) {
    for (const f of page.frames()) if (await f.locator('#agents .agent-card').count().catch(() => 0)) { frame = f; break; }
    if (frame) break; await sleep(500);
  }
  if (!frame) {
    await page.screenshot({ path: 'artifacts/sidebar-render-failure.png' });
    await writeFile('artifacts/sidebar-render-failure.json', JSON.stringify({ frames: page.frames().map(f => f.url()), text: (await page.locator('body').innerText()).slice(-8000) }, null, 2));
    throw new Error('Chatroom webview never rendered its agent controls');
  }
  await frame.locator('#prompt').fill('Sidebar render check');
  await frame.getByRole('button', { name: 'Settings', exact: true }).click();
  await frame.getByRole('heading', { name: 'Models and defaults' }).waitFor();
  await frame.getByRole('button', { name: 'Close', exact: true }).click();
  const artifact = legacy ? 'sidebar-legacy' : restored ? 'sidebar-restored' : 'sidebar-render';
  await page.screenshot({ path: `artifacts/${artifact}.png` });
  console.log('Actual VS Code webview rendered: agent controls, composer, model-defaults dialog.');
  await writeFile(`artifacts/${artifact}.json`, JSON.stringify({ passed: true, time: new Date().toISOString(), checks: [restored ? 'restored sidebar without invoking a command' : 'open command auto activation', 'actual webview iframe', 'agent controls rendered', 'composer input', 'settings dialog'] }, null, 2));
} finally {
  if (browser) {
    try { await browser.contexts()[0]?.pages().find(p => /workbench/.test(p.url()))?.close(); } catch {}
    await browser.close().catch(() => {});
  }
  if (!child.killed) child.kill();
}
