const puppeteer = require('puppeteer');
const jwt = require('jsonwebtoken');

async function getBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions'
    ]
  });
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
  const targetUrl = `${appUrl}/index.html`;
  const renderToken = getRenderToken();

  const browser = await getBrowser();
  const page = await browser.newPage();
  const docType = presetData.documentType || 'unknown';

  try {
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(15000);

    page.on('pageerror', (err) => {
      console.error(`PDF page error (${docType}):`, err.message);
    });

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//i.test(url)) {
        request.abort().catch(() => {});
        return;
      }
      request.continue().catch(() => {});
    });

    // Inject auth token before app scripts run, so checkSession() passes on first load.
    await page.evaluateOnNewDocument((token) => {
      window.localStorage.setItem('token', token);
    }, renderToken);

    // Load the app once, then inject the preset directly. This avoids very long hash URLs
    // and makes repeated Railway renders less dependent on navigation timing.
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.waitForFunction(() => typeof window._loadPreset === 'function', { timeout: 20000 });
    await page.evaluate((data) => {
      window._loadPreset(data);
    }, presetData);

    const reportSelector = {
      payroll: '#paystub',
      noaStatement: '#noaReport',
      t4Slip: '#t4Report',
      tdVoidCheck: '#tdVoidReport',
      bmoVoidCheck: '#bmoVoidReport',
      scotiaVoidCheck: '#scotiaVoidReport',
      rbcVoidCheck: '#rbcVoidReport',
      cibcVoidCheck: '#cibcVoidReport',
      statement: '#statementReport',
      scotiaStatement: '#scotiaReport',
      cibcStatement: '#cibcReport',
      rbcStatement: '#rbcReport'
    }[docType] || '#paystub';

    const ready = await page.waitForFunction((selector) => {
      const report = document.querySelector(selector);
      if (!report || report.classList.contains('is-hidden')) return false;
      const rect = report.getBoundingClientRect();
      return rect.height > 100 && rect.width > 100;
    }, { timeout: 10000 }, reportSelector).then(() => true).catch((err) => {
      console.warn(`PDF preview readiness timed out (${docType}, ${reportSelector}): ${err.message}`);
      return false;
    });

    // Settle — fonts, images, JS layout
    await Promise.race([
      page.evaluate(() => document.fonts?.ready).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
    await new Promise(r => setTimeout(r, ready ? 1000 : 3000));

    // Strip all UI chrome and expose only the document preview at full width.
    // The web app's calculations have already run; we just need a clean capture.
    await page.evaluate((type) => {
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

      if (type === 'payroll') {
        const style = document.createElement('style');
        style.textContent = `
          @page { size: A4; margin: 0; }
          html, body { width: 210mm; margin: 0 !important; padding: 0 !important; background: #fff !important; }
          #paystub { width: 210mm !important; max-width: none !important; margin: 0 !important; border: 0 !important; background: #fff !important; }
          #paystub .statement { width: 210mm !important; min-height: 297mm !important; padding: 13mm 12mm 10mm !important; background-size: auto 4.4mm !important; overflow: hidden !important; }
          #paystub .statement-header { gap: 7mm !important; }
          #paystub .brand { font-size: 10mm !important; line-height: 1 !important; }
          #paystub .statement-meta h2 { font-size: 6.6mm !important; margin-bottom: 2.6mm !important; }
          #paystub .statement-meta p { margin: 0.35mm 0 !important; }
          #paystub .statement-meta address { margin-top: 4mm !important; line-height: 1.18 !important; }
          #paystub .statement-grid { display: block !important; margin-top: 9mm !important; }
          #paystub .slip-block h3 { font-size: 5mm !important; margin: 4.5mm 0 1.6mm !important; }
          #paystub .slip-table { font-size: 3.6mm !important; line-height: 1.05 !important; }
          #paystub .slip-table th, #paystub .slip-table td { padding: 1.15mm 1mm !important; }
          #paystub .notes { margin-top: 5mm !important; line-height: 1.18 !important; font-size: 3.6mm !important; }
          #paystub .hours-block { margin-top: 4.8mm !important; padding: 1.5mm 0 !important; }
          #paystub .hours-block p, #paystub .deposit-box p { margin: 1.3mm 0 !important; }
          #paystub .deposit-box { padding-bottom: 1.5mm !important; }
          #paystub .statement-footer { margin-top: 6mm !important; }
          #paystub .strong-line { padding: 1.7mm 0 !important; font-size: 4.9mm !important; break-inside: avoid !important; page-break-inside: avoid !important; }
        `;
        document.head.appendChild(style);
      }

      if (type === 'noaStatement') {
        const style = document.createElement('style');
        style.textContent = `
          @page { size: A4; margin: 0; }
          html, body { width: 210mm; margin: 0 !important; padding: 0 !important; background: #fff !important; }
          #noaReport { width: 210mm !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: #fff !important; }
          #noaReport .noa-page { width: 210mm !important; height: 297mm !important; margin: 0 !important; break-after: page; page-break-after: always; overflow: hidden !important; box-shadow: none !important; border: 0 !important; }
          #noaReport .noa-page + .noa-page { margin-top: 0 !important; }
          #noaReport .noa-page:last-child { break-after: auto; page-break-after: auto; }
        `;
        document.head.appendChild(style);
      }

      if (type === 'tdVoidCheck') {
        const style = document.createElement('style');
        style.textContent = `
          @page { size: A4; margin: 0; }
          html, body { width: 210mm; height: 297mm; margin: 0 !important; padding: 0 !important; background: #fff !important; overflow: hidden !important; }
          #tdVoidReport { display: block !important; width: 210mm !important; height: 297mm !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: #fff !important; overflow: hidden !important; }
          #tdVoidPage { width: 210mm !important; height: 297mm !important; margin: 0 !important; box-shadow: none !important; border: 0 !important; break-after: auto !important; page-break-after: auto !important; overflow: hidden !important; }
          #tdVoidPage .td-void-bg-image { object-fit: fill !important; transform: scaleX(0.92) !important; transform-origin: center top !important; }
          #tdVoidPage .td-void-overlay { transform: scaleX(0.92) !important; transform-origin: center top !important; }
        `;
        document.head.appendChild(style);
      }

      if (type === 'scotiaVoidCheck') {
        const style = document.createElement('style');
        style.textContent = `
          @page { size: A4; margin: 0; }
          html, body { width: 210mm; height: 297mm; margin: 0 !important; padding: 0 !important; background: #fff !important; overflow: hidden !important; }
          #scotiaVoidReport { display: block !important; width: 210mm !important; height: 297mm !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: #fff !important; overflow: hidden !important; }
          #scotiaVoidPage { width: 210mm !important; height: 297mm !important; margin: 0 !important; box-shadow: none !important; border: 0 !important; break-after: auto !important; page-break-after: auto !important; overflow: hidden !important; }
        `;
        document.head.appendChild(style);
      }

      if (['bmoVoidCheck', 'rbcVoidCheck'].includes(type)) {
        const ids = {
          bmoVoidCheck: { report: 'bmoVoidReport', page: 'bmoVoidPage' },
          rbcVoidCheck: { report: 'rbcVoidReport', page: 'rbcVoidPage' },
        }[type];
        const style = document.createElement('style');
        style.textContent = `
          @page { size: A4; margin: 0; }
          html, body { width: 210mm; height: 297mm; margin: 0 !important; padding: 0 !important; background: #fff !important; overflow: hidden !important; }
          #${ids.report} { display: block !important; width: 210mm !important; height: 297mm !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: #fff !important; overflow: hidden !important; }
          #${ids.page} { width: 210mm !important; height: 297mm !important; margin: 0 !important; box-shadow: none !important; border: 0 !important; break-after: auto !important; page-break-after: auto !important; overflow: hidden !important; }
        `;
        document.head.appendChild(style);
      }

      if (type === 'cibcVoidCheck') {
        const style = document.createElement('style');
        style.textContent = `
          @page { size: A4; margin: 0; }
          html, body { width: 210mm; margin: 0 !important; padding: 0 !important; background: #fff !important; overflow-x: hidden !important; }
          #cibcVoidReport { display: block !important; width: 210mm !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: #fff !important; }
          #cibcVoidReport .cibc-void-page { width: 210mm !important; height: 297mm !important; margin: 0 !important; box-shadow: none !important; border: 0 !important; overflow: hidden !important; }
          #cibcVoidPage1 { break-after: page !important; page-break-after: always !important; }
          #cibcVoidPage2 { break-before: auto !important; page-break-before: auto !important; break-after: auto !important; page-break-after: auto !important; }
        `;
        document.head.appendChild(style);
      }

      if (type === 'cibcStatement') {
        const style = document.createElement('style');
        style.textContent = `
          @page { size: A4; margin: 0; }
          html, body { width: 210mm; margin: 0 !important; padding: 0 !important; background: #fff !important; overflow-x: hidden !important; }
          #cibcReport { display: block !important; width: 210mm !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: #fff !important; }
          #cibcReport .cibc-page { width: 210mm !important; height: 297mm !important; min-height: 0 !important; margin: 0 !important; box-shadow: none !important; border: 0 !important; overflow: hidden !important; break-after: page !important; page-break-after: always !important; }
          #cibcReport .cibc-page:last-child { break-after: auto !important; page-break-after: auto !important; }
          #cibcReport .cibc-page-break { break-before: auto !important; page-break-before: auto !important; }
        `;
        document.head.appendChild(style);
      }

      if (type === 'scotiaStatement') {
        const style = document.createElement('style');
        style.textContent = `
          @page { size: A4; margin: 0; }
          html, body { width: 210mm; margin: 0 !important; padding: 0 !important; background: #fff !important; overflow-x: hidden !important; }
          #scotiaReport { display: block !important; width: 210mm !important; margin: 0 !important; padding: 0 !important; border: 0 !important; background: #fff !important; }
          #scotiaReport .scotia-page { width: 210mm !important; height: 297mm !important; min-height: 0 !important; margin: 0 !important; padding: 0.58in 0.86in 0.5in 0.92in !important; box-shadow: none !important; border: 0 !important; overflow: hidden !important; break-after: page !important; page-break-after: always !important; }
          #scotiaReport .scotia-page:last-child { break-after: auto !important; page-break-after: auto !important; }
          #scotiaReport .scotia-page-break { break-before: auto !important; page-break-before: auto !important; }
          #scotiaReport .scotia-logo { width: 170px !important; }
          #scotiaReport .scotia-banner { padding: 0.17in 0.35in !important; }
          #scotiaReport .scotia-main-column { width: 6.92in !important; max-width: 100% !important; }
          #scotiaReport .scotia-page-number { width: 6.92in !important; }
          #scotiaReport .scotia-ledger { table-layout: fixed !important; width: 100% !important; font-size: 8.8pt !important; }
          #scotiaReport .scotia-ledger td { padding: 0.023in 0.06in !important; }
          #scotiaReport .scotia-ledger td.sc-desc .sc-desc-type { font-weight: 400 !important; }
          #scotiaReport .scotia-ledger td.sc-desc .sc-desc-detail { font-size: 8.6pt !important; line-height: 1.08 !important; }
          #scotiaReport .scotia-ledger td:nth-child(3),
          #scotiaReport .scotia-ledger td:nth-child(4),
          #scotiaReport .scotia-ledger td:nth-child(5) { white-space: nowrap !important; }
        `;
        document.head.appendChild(style);
      }
    }, docType);

    const visibleReport = await page.evaluate(() => {
      const report = document.querySelector(
        '#paystub:not(.is-hidden), #noaReport:not(.is-hidden), #t4Report:not(.is-hidden), #tdVoidReport:not(.is-hidden), #bmoVoidReport:not(.is-hidden), #scotiaVoidReport:not(.is-hidden), #rbcVoidReport:not(.is-hidden), #cibcVoidReport:not(.is-hidden), #statementReport:not(.is-hidden), #scotiaReport:not(.is-hidden), #cibcReport:not(.is-hidden), #rbcReport:not(.is-hidden)'
      );
      if (!report) return null;
      const rect = report.getBoundingClientRect();
      return { id: report.id, width: rect.width, height: rect.height };
    });
    if (!visibleReport || visibleReport.height < 100 || visibleReport.width < 100) {
      throw new Error(`Document preview did not render for ${docType}`);
    }

    const pdfOptions = {
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' }
    };

    const pdfData = await page.pdf(pdfOptions);

    const pdfBuf = Buffer.from(pdfData);
    if (pdfBuf.length < 2000) throw new Error(`PDF too small: ${pdfBuf.length} bytes — page did not render`);

    console.log(`PDF generated (${docType}, ${visibleReport.id}): ${pdfBuf.length} bytes`);
    return pdfBuf;

  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { generatePdf };
