const { firefox } = require('playwright');
const fs = require('fs');
const pathModule = require('path');

const AUDIT_DIR = './app-audit-prod';
const SCREENSHOTS_DIR = pathModule.join(AUDIT_DIR, 'screenshots');
const FINDINGS_DIR = pathModule.join(AUDIT_DIR, 'findings');

// Ensure directories exist
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (!fs.existsSync(FINDINGS_DIR)) fs.mkdirSync(FINDINGS_DIR, { recursive: true });

const routes = [
  { label: 'kn-graph', path: '/thomas-anderson-mac/default/knowledge/graph' },
  { label: 'kn-nodes', path: '/thomas-anderson-mac/default/knowledge/nodes' },
  { label: 'kn-memories', path: '/thomas-anderson-mac/default/knowledge/memories' },
  { label: 'kn-sources', path: '/thomas-anderson-mac/default/knowledge/sources' },
  { label: 'studio-compose', path: '/thomas-anderson-mac/default/studio/compose' },
  { label: 'studio-library', path: '/thomas-anderson-mac/default/studio/library' }
];

async function auditRoute(page, label, routePath) {
  const findings = {
    label,
    path: routePath,
    status: 'OK',
    previewMock: 'NO',
    console: 'none',
    forms: 'none',
    bugs: 'none',
    notes: ''
  };

  try {
    console.log(`\nAuditing: ${label} (${routePath})`);
    await page.goto(`https://app.oxagen.sh${routePath}`, { 
      waitUntil: 'domcontentloaded',
      timeout: 15000 
    });
    
    // Wait for page to settle (spinners/skeleton resolving)
    await page.waitForTimeout(4000);
    
    // Check page URL (detect redirects)
    const finalUrl = page.url();
    if (finalUrl.includes('/login')) {
      findings.status = 'ERROR: redirect→/login';
    }
    
    // Take screenshot
    const screenshotPath = pathModule.join(SCREENSHOTS_DIR, `${label}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`  ✓ Screenshot: ${label}.png`);
    
    // Get page text (first 4000 chars)
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    const textSlice = pageText.slice(0, 4000);
    
    // Check for preview/mock keywords (case-insensitive)
    const mockPatterns = [
      /preview/i, /coming soon/i, /mock/i, /sample data/i, /demo data/i,
      /placeholder/i, /not yet/i, /no live data/i, /example data/i, /static/i
    ];
    
    for (const pattern of mockPatterns) {
      const match = textSlice.match(pattern);
      if (match) {
        findings.previewMock = `YES "${match[0]}"`;
        break;
      }
    }
    
    // Check console for errors
    const consoleMessages = [];
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleMessages.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
      }
    });
    
    // Capture any errors during page load
    page.on('pageerror', err => {
      consoleMessages.push(`[ERROR] ${err.message}`);
    });
    
    // Give a moment for console messages to arrive
    await page.waitForTimeout(1000);
    
    if (consoleMessages.length > 0) {
      findings.console = consoleMessages.slice(0, 3).join('; ');
    }
    
    // Detect common bugs
    const bugs = [];
    
    // Check for blank page
    if (textSlice.trim().length === 0) {
      bugs.push('P1: Blank page (no content rendered)');
    }
    
    // Check for error boundaries
    if (/error|something went wrong|oops|500|404/i.test(textSlice.slice(0, 1000))) {
      bugs.push('P1: Error message or error boundary detected');
    }
    
    // Check for infinite spinner
    if (/loading|skeleton|spinner/i.test(textSlice) && textSlice.length < 100) {
      bugs.push('P2: Page may be stuck loading (spinner detected, minimal content)');
    }
    
    // Check for broken images
    const brokenImages = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img'))
        .filter(img => !img.complete || img.naturalHeight === 0)
        .length;
    });
    if (brokenImages > 0) {
      bugs.push(`P2: ${brokenImages} broken/missing images detected`);
    }
    
    // Check for untranslated i18n keys
    if (/\{\{[a-zA-Z]+\}\}|\[[a-zA-Z]+\]/i.test(textSlice)) {
      bugs.push('P2: Untranslated i18n keys detected');
    }
    
    if (bugs.length > 0) {
      findings.bugs = bugs.join('; ');
    }
    
    // Extract notes about visible capabilities/data
    if (label.includes('graph')) {
      findings.notes = 'WebGL graph visualization (reagraph) - check if nodes render';
    } else if (label.includes('studio')) {
      findings.notes = 'Content generation interface - verify form fields';
    } else if (label.includes('kn-')) {
      findings.notes = 'Knowledge base view - check data display';
    }
    
  } catch (error) {
    findings.status = `ERROR: ${error.message}`;
    console.log(`  ✗ Error: ${error.message}`);
  }
  
  return findings;
}

async function runAudit() {
  console.log('Starting production app audit...');
  
  const browser = await firefox.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Set viewport
  await page.setViewportSize({ width: 1440, height: 1800 });
  
  // Load authentication state if it exists
  const authPath = pathModule.join(AUDIT_DIR, 'auth.json');
  if (fs.existsSync(authPath)) {
    try {
      const authState = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      await context.addCookies(authState.cookies || []);
      console.log('Loaded authentication state');
    } catch (e) {
      console.log('Could not load auth state:', e.message);
    }
  }
  
  const allFindings = [];
  
  for (const route of routes) {
    const findings = await auditRoute(page, route.label, route.path);
    allFindings.push(findings);
  }
  
  // Write findings to markdown
  let markdown = '# Production App Audit Results\n\n';
  
  for (const finding of allFindings) {
    markdown += `## ${finding.label} — ${finding.path}\n`;
    markdown += `- Status: ${finding.status}\n`;
    markdown += `- Preview/mock: ${finding.previewMock}\n`;
    markdown += `- Console: ${finding.console}\n`;
    markdown += `- Forms: ${finding.forms}\n`;
    markdown += `- Bugs: ${finding.bugs}\n`;
    markdown += `- Notes: ${finding.notes}\n\n`;
  }
  
  const findingsPath = pathModule.join(FINDINGS_DIR, 'group-B.md');
  fs.writeFileSync(findingsPath, markdown);
  console.log(`\n✓ Findings written to: ${findingsPath}`);
  
  // Print summary
  console.log('\n=== AUDIT SUMMARY ===');
  const errors = allFindings.filter(f => f.status !== 'OK');
  const mocks = allFindings.filter(f => f.previewMock !== 'NO');
  const bugs = allFindings.filter(f => f.bugs !== 'none');
  
  console.log(`Total routes audited: ${allFindings.length}`);
  console.log(`Errored/redirected: ${errors.length}`);
  console.log(`Preview/mock pages: ${mocks.length}`);
  console.log(`Pages with bugs: ${bugs.length}`);
  
  await browser.close();
  console.log('\nAudit complete.');
}

runAudit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
