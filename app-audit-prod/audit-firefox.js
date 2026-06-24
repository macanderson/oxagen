const { firefox } = require('playwright');
const fs = require('fs');

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

async function auditPage(browser, label, routePath) {
  const page = await browser.newPage();
  
  try {
    // Load auth cookies
    const authData = JSON.parse(fs.readFileSync('auth.json', 'utf8'));
    if (authData.cookies) {
      await page.context().addCookies(authData.cookies);
    }
    
    console.log(`[${label}] Navigating...`);
    await page.goto(`https://app.oxagen.sh${routePath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    
    const screenshotPath = `screenshots/${label}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[${label}] ✓ Screenshot saved`);
    
    const innerText = await page.evaluate(() => document.body.innerText);
    const textSlice = innerText.slice(0, 4000);
    
    // Check for mock keywords
    const mockKeywords = ['preview', 'coming soon', 'mock', 'sample data', 'demo data', 'placeholder', 'not yet', 'no live data', 'example data', 'static'];
    const foundMocks = mockKeywords.filter(kw => textSlice.toLowerCase().includes(kw.toLowerCase()));
    
    return {
      label,
      path: routePath,
      status: 'OK',
      mocks: foundMocks.length > 0 ? foundMocks : null,
      hasContent: textSlice.length > 100
    };
  } catch (err) {
    console.log(`[${label}] ✗ Error: ${err.message}`);
    return {
      label,
      path: routePath,
      status: 'ERROR',
      error: err.message
    };
  } finally {
    await page.close();
  }
}

async function main() {
  if (!fs.existsSync('screenshots')) fs.mkdirSync('screenshots');
  
  const browser = await firefox.launch();
  const results = [];
  
  try {
    for (const [label, path] of routes) {
      const result = await auditPage(browser, label, path);
      results.push(result);
    }
  } finally {
    await browser.close();
  }
  
  fs.writeFileSync('audit-results.json', JSON.stringify(results, null, 2));
  console.log('\n✓ Audit complete. Results in audit-results.json');
}

main().catch(console.error);
