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
  const logs = { console: [], network: [] };
  
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      logs.console.push({ type: msg.type(), text: msg.text() });
    }
  });
  
  try {
    const authData = JSON.parse(fs.readFileSync('auth.json', 'utf8'));
    if (authData.cookies) {
      await page.context().addCookies(authData.cookies);
    }
    
    await page.goto(`https://app.oxagen.sh${routePath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    
    const innerText = await page.evaluate(() => document.body.innerText);
    const textSlice = innerText.slice(0, 3500);
    
    const mockKeywords = ['preview', 'coming soon', 'mock', 'sample data', 'demo data', 'placeholder', 'not yet', 'no live data', 'example data', 'static'];
    const foundMocks = mockKeywords.filter(kw => textSlice.toLowerCase().includes(kw.toLowerCase()));
    
    // Extract form data
    const forms = await page.evaluate(() => {
      const formElements = Array.from(document.querySelectorAll('form, [role="form"], button[type="submit"]'));
      return formElements.length;
    });
    
    // Check for images
    const images = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.filter(img => !img.src || img.src.includes('undefined') || !img.src.startsWith('data:')).length;
    });
    
    return {
      label,
      path: routePath,
      status: 'OK',
      mocks: foundMocks.length > 0 ? foundMocks : null,
      console: logs.console.length > 0 ? logs.console : null,
      forms,
      textPreview: textSlice.substring(0, 500)
    };
  } catch (err) {
    return {
      label,
      path: routePath,
      status: 'ERROR',
      error: err.message,
      console: logs.console
    };
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await firefox.launch();
  const results = [];
  
  for (const [label, path] of routes) {
    const result = await auditPage(browser, label, path);
    results.push(result);
    console.log(`${label}: ${result.status}${result.mocks ? ' (mocks: ' + result.mocks.join(', ') + ')' : ''}`);
  }
  
  await browser.close();
  
  fs.writeFileSync('detailed-results.json', JSON.stringify(results, null, 2));
  console.log('\nDetailed results saved to detailed-results.json');
}

main().catch(console.error);
