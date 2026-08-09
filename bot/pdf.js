const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process'
    ]
  });
  browserInstance.on('disconnected', () => { browserInstance = null; });
  return browserInstance;
}

function getRenderToken() {
  return jwt.sign(
    { email: 'renderer@replicas.live' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function getRenderBaseUrl() {
  if (process.env.RENDER_BASE_URL) return process.env.RENDER_BASE_URL.replace(/\/+$/, '');
  const port = parseInt(process.env.PORT, 10) || 5000;
  return `http://127.0.0.1:${port}`;
}

async function generatePdf(presetData) {
  const appUrl = getRenderBaseUrl();
  const b64 = Buffer.from(unescape(encodeURIComponent(JSON.stringify(presetData)))).toString('base64');
  const targetUrl = `${appUrl}/index.html#preset=${b64}`;
  const renderToken = getRenderToken();

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(45000);

    // Visit origin first so localStorage is scoped to the right domain
    await page.goto(`${appUrl}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Inject auth token — checkSession() in index.html will find it and pass
    await page.evaluate((token) => {
      localStorage.setItem('token', token);
    }, renderToken);

    // Load the document page; the web app's PayrollEngine + renderers run here
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // Wait for the preview section to be populated by the app
    await page.waitForFunction(() => {
      const report = document.querySelector(
        '.paystub:not(.is-hidden), #noaReport:not(.is-hidden), #t4Report:not(.is-hidden), #tdVoidReport:not(.is-hidden), #bmoVoidReport:not(.is-hidden), #scotiaVoidReport:not(.is-hidden), #rbcVoidReport:not(.is-hidden), #cibcVoidReport:not(.is-hidden), #statementReport:not(.is-hidden), #scotiaReport:not(.is-hidden), #cibcReport:not(.is-hidden), #rbcReport:not(.is-hidden)'
      );
      return report && report.getBoundingClientRect().height > 100;
    }, { timeout: 30000 });

    // Settle — fonts, images, JS layout
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    // Strip all UI chrome and expose only the document preview at full width.
    // The web app's calculations have already run; we just need a clean capture.
    await page.evaluate(() => {
      const s = (sel, styles) => document.querySelectorAll(sel).forEach(el => Object.assign(el.style, styles));
      const hide = sel => s(sel, { display: 'none' });

      // Hide navigation / controls
      hide('.topbar');
      hide('.sidebar');
      hide('.controls-panel');
      hide('.app-header');
      hide('.status-bar');
      hide('.save-status');
      hide('.quick-save-bar');
      hide('.paystub-status');
      hide('#paystubStatus');

      // Hide the check stub portion (VOID / NON-NEGOTIABLE) — not part of the earnings statement
      hide('.cheque-section');

      // Make the preview column fill the full page width
      const previewWrap = document.querySelector('.preview-area, .preview-panel, .right-panel, #previewPanel');
      if (previewWrap) Object.assign(previewWrap.style, { width: '100%', maxWidth: '100%', padding: '0', margin: '0' });

      // Make body / layout fill width cleanly
      document.body.style.cssText = 'margin:0;padding:0;background:#fff;';
      const app = document.querySelector('.app-layout, .app, #app, main');
      if (app) Object.assign(app.style, { display: 'block', width: '100%' });
    });

    const pdfData = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' }
    });

    const pdfBuf = Buffer.from(pdfData);
    if (pdfBuf.length < 2000) throw new Error(`PDF too small: ${pdfBuf.length} bytes — page did not render`);

    console.log(`PDF generated: ${pdfBuf.length} bytes`);
    return pdfBuf;

  } finally {
    await page.close();
  }
}

module.exports = { generatePdf };
async function generatePdf(presetData) {
  const appUrl = getRenderBaseUrl();
  const b64 = Buffer.from(unescape(encodeURIComponent(JSON.stringify(presetData)))).toString('base64');
  const targetUrl = `${appUrl}/index.html#preset=${b64}`;
  const renderToken = getRenderToken();

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(45000);

    // Visit origin first so localStorage is scoped to the right domain
    await page.goto(`${appUrl}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Inject auth token — checkSession() in index.html will find it and pass
    await page.evaluate((token) => {
      localStorage.setItem('token', token);
    }, renderToken);

    // Load the document page; the web app's PayrollEngine + renderers run here
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // Wait for the preview section to be populated by the app
    await page.waitForFunction(() => {
      const report = document.querySelector(
        '.paystub:not(.is-hidden), #noaReport:not(.is-hidden), #t4Report:not(.is-hidden), #tdVoidReport:not(.is-hidden), #bmoVoidReport:not(.is-hidden), #scotiaVoidReport:not(.is-hidden), #rbcVoidReport:not(.is-hidden), #cibcVoidReport:not(.is-hidden), #statementReport:not(.is-hidden), #scotiaReport:not(.is-hidden), #cibcReport:not(.is-hidden), #rbcReport:not(.is-hidden)'
      );
      return report && report.getBoundingClientRect().height > 100;
    }, { timeout: 30000 });

    // Settle — fonts, images, JS layout
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    // Strip all UI chrome and expose only the document preview at full width.
    // The web app's calculations have already run; we just need a clean capture.
    await page.evaluate(() => {
      const s = (sel, styles) => document.querySelectorAll(sel).forEach(el => Object.assign(el.style, styles));
      const hide = sel => s(sel, { display: 'none' });

      // Hide navigation / controls
      hide('.topbar');
      hide('.sidebar');
      hide('.controls-panel');
      hide('.app-header');
      hide('.status-bar');
      hide('.save-status');
      hide('.quick-save-bar');
      hide('.paystub-status');
      hide('#paystubStatus');

      // Hide the check stub portion (VOID / NON-NEGOTIABLE) — not part of the earnings statement
      hide('.cheque-section');

      // Make the preview column fill the full page width
      const previewWrap = document.querySelector('.preview-area, .preview-panel, .right-panel, #previewPanel');
      if (previewWrap) Object.assign(previewWrap.style, { width: '100%', maxWidth: '100%', padding: '0', margin: '0' });

      // Make body / layout fill width cleanly
      document.body.style.cssText = 'margin:0;padding:0;background:#fff;';
      const app = document.querySelector('.app-layout, .app, #app, main');
      if (app) Object.assign(app.style, { display: 'block', width: '100%' });
    });

    const pdfData = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' }
    });

    const pdfBuf = Buffer.from(pdfData);
    if (pdfBuf.length < 2000) throw new Error(`PDF too small: ${pdfBuf.length} bytes — page did not render`);

    console.log(`PDF generated: ${pdfBuf.length} bytes`);
    return pdfBuf;

  } finally {
    await page.close();
  }
}

module.exports = { generatePdf };
    // Settle — fonts, images, JS layout

    // Strip all UI chrome and expose only the document preview at full width.
    // The web app's calculations have already run; we just need a clean capture.
    await page.evaluate(() => {
      const s = (sel, styles) => document.querySelectorAll(sel).forEach(el => Object.assign(el.style, styles));
      const hide = sel => s(sel, { display: 'none' });

      // Hide navigation / controls
      hide('.topbar');
      hide('.sidebar');
      hide('.controls-panel');
      hide('.app-header');
      hide('.status-bar');
      hide('.save-status');
      hide('.quick-save-bar');
      hide('.paystub-status');
      hide('#paystubStatus');

      // Hide the check stub portion (VOID / NON-NEGOTIABLE) — not part of the earnings statement
      hide('.cheque-section');

      // Make the preview column fill the full page width
      const previewWrap = document.querySelector('.preview-area, .preview-panel, .right-panel, #previewPanel');
      if (previewWrap) Object.assign(previewWrap.style, { width: '100%', maxWidth: '100%', padding: '0', margin: '0' });

      // Make body / layout fill width cleanly
      document.body.style.cssText = 'margin:0;padding:0;background:#fff;';
      const app = document.querySelector('.app-layout, .app, #app, main');
      if (app) Object.assign(app.style, { display: 'block', width: '100%' });
    });

    const pdfData = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' }
    });

    const pdfBuf = Buffer.from(pdfData);
    if (pdfBuf.length < 2000) throw new Error(`PDF too small: ${pdfBuf.length} bytes — page did not render`);

    console.log(`PDF generated: ${pdfBuf.length} bytes`);
    return pdfBuf;

  } finally {
    await page.close();
  }
}

module.exports = { generatePdf };
