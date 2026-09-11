import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

// Prefer an explicit browser, then Playwright's matching browser, then an
// already-installed full Chromium. Full Chromium is required for extensions.
export function browserPath() {
  const explicit = process.env.CHROMIUM_PATH || process.env.CHROME_PATH;
  if (explicit) return explicit;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'ms-playwright') : process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright'));
  if (existsSync(base)) {
    const releases = readdirSync(base).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const release of releases) for (const suffix of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
      const path = join(base, release, suffix);
      if (existsSync(path)) return path;
    }
  }
  throw new Error('未找到测试用 Chromium。请运行 npx playwright install chromium，或设置 CHROMIUM_PATH。');
}
