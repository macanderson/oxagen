const { firefox } = require('playwright');
const fs = require('fs');
const pathModule = require('path');

const AUDIT_DIR = './app-audit-prod';
const SCREENSHOTS_DIR = pathModule.join(AUDIT_DIR, 'screenshots');
const FINDINGS_DIR = pathModule.join(AUDIT_DIR, 'findings');

const routes = [
  { label: 'kn-nodes', path: '/thomas-anderson-mac/default/knowledge/nodes' },
  { label: 'kn-memories', path: '/thomas-anderson-mac/default/knowledge/memories' },
  { label: 'studio-compose', path: '/thomas-anderson-mac/default/studio/compose' },
  { label: 'studio-library', path: '/thomas-anderson-mac/default/studio/library' }
];

async function analyzeRoute(page, label, routePath) {
  console.log(`\n=== Analyzing: ${label} ===`);
  
  try {
    await page.goto(`https://app.oxagen.sh${routePath}`, { 
      waitUntil: 'domcontentloaded',
      timeout: 15000 
    });
    await page.waitForTimeout(4000);
    
    // Get page text
    const fullText = await page.evaluate(() => document.body.innerText);
    console.log(`Page text (first 1500 chars):\n${fullText.slice(0, 1500)}\n`);
    
    // Check for specific error patterns
    if (/error|something went wrong|oops/i.test(fullText)) {
      console.log('DETECTED: Error message in page text');
    }
    
    // Check for preview/mock in multiple places
    const mainContent = await page.evaluate(() => {
      return {
        bodyClass: document.body.className,
        h1: document.querySelector('h1')?.textContent || 'none',
        h2: document.querySelector('h2')?.textContent || 'none',
        buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent).slice(0, 5)
      };
    });
    
    console.log('Page structure:', JSON.stringify(mainContent, null, 2));
    
    // List screenshot files
    const screenshots = fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.startsWith(label));
    console.log(`Screenshots: ${screenshots.join(', ')}`);
    
  } catch (error) {
    console.log(`Error: ${error.message}`);
  }
}

async function runDetailAnalysis() {
  const browser = await firefox.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.setViewportSize({ width: 1440, height: 1800 });
  
  const authPath = pathModule.join(AUDIT_DIR, 'auth.json');
  if (fs.existsSync(authPath)) {
    const authState = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    await context.addCookies(authState.cookies || []);
  }
  
  for (const route of routes) {
    await analyzeRoute(page, route.label, route.path);
  }
  
  await browser.close();
  console.log('\nDetail analysis complete.');
}

runDetailAnalysis().catch(console.error);
