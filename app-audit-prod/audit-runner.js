const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const routes = [
  ['ws-set-general', '/thomas-anderson-mac/default/settings/general'],
  ['ws-set-knowledge', '/thomas-anderson-mac/default/settings/knowledge'],
  ['ws-set-integrations', '/thomas-anderson-mac/default/settings/integrations'],
  ['ws-set-model-keys', '/thomas-anderson-mac/default/settings/model-keys'],
  ['ws-set-plugins', '/thomas-anderson-mac/default/settings/plugins'],
  ['ws-set-brand-kits', '/thomas-anderson-mac/default/settings/brand-kits'],
  ['ws-set-skills', '/thomas-anderson-mac/default/settings/skills'],
  ['ws-set-models', '/thomas-anderson-mac/default/settings/models'],
  ['ws-set-prompts', '/thomas-anderson-mac/default/settings/prompts'],
  ['ws-set-members', '/thomas-anderson-mac/default/settings/members']
];

async function auditPage(browser, label, path) {
  const page = await browser.newPage();
  
  // Load auth cookies
  const authData = JSON.parse(fs.readFileSync('auth.json', 'utf8'));
  if (authData.cookies) {
    await page.context().addCookies(authData.cookies);
  }
  
  try {
    console.log(`\n[${label}] Navigating to ${path}...`);
    await page.goto(`https://app.oxagen.sh${path}`, { waitUntil: 'networkidle' });
    
    // Wait for content to load
    await page.waitForTimeout(4000);
    
    // Take screenshot
    const screenshotPath = path.join('screenshots', `${label}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[${label}] Screenshot saved: ${screenshotPath}`);
    
    // Get inner text (first 4000 chars)
    const innerText = await page.evaluate(() => document.body.innerText);
    const textSlice = innerText.slice(0, 4000);
    console.log(`[${label}] Text sample: ${textSlice.substring(0, 200)}...`);
    
    // Check console errors
    const consoleMessages = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleMessages.push(msg.text());
      }
    });
    
    // Scan for preview/mock keywords
    const mockKeywords = ['preview', 'coming soon', 'mock', 'sample data', 'demo data', 'placeholder', 'not yet', 'no live data', 'example data', 'static'];
    const foundMocks = [];
    mockKeywords.forEach(keyword => {
      if (textSlice.toLowerCase().includes(keyword.toLowerCase())) {
        foundMocks.push(keyword);
      }
    });
    
    console.log(`[${label}] Mock keywords found: ${foundMocks.length > 0 ? foundMocks.join(', ') : 'none'}`);
    
    return {
      label,
      path,
      status: 'OK',
      mockKeywords: foundMocks,
      consoleErrors: consoleMessages,
      textPreview: textSlice
    };
  } catch (err) {
    console.error(`[${label}] Error: ${err.message}`);
    return {
      label,
      path,
      status: 'ERROR',
      error: err.message
    };
  } finally {
    await page.close();
  }
}

async function main() {
  // Create screenshots dir
  if (!fs.existsSync('screenshots')) {
    fs.mkdirSync('screenshots');
  }
  
  const browser = await chromium.launch({ executablePath: '/snap/bin/chromium' });
  const results = [];
  
  try {
    for (const [label, routePath] of routes) {
      const result = await auditPage(browser, label, routePath);
      results.push(result);
    }
  } finally {
    await browser.close();
  }
  
  // Save results
  fs.writeFileSync('audit-results.json', JSON.stringify(results, null, 2));
  console.log('\n=== AUDIT COMPLETE ===');
  console.log('Results saved to audit-results.json');
}

main().catch(console.error);
