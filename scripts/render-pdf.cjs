const { chromium } = require('playwright');

const url = process.argv[2];
const out = process.argv[3] || 'output.pdf';
if (!url) {
  console.error('usage: node render-pdf.cjs <url> [out.pdf]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight / 2));
    let last = -1;
    for (let i = 0; i < 400; i++) {
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 150));
      const y = window.scrollY + window.innerHeight;
      if (y >= document.documentElement.scrollHeight - 2 && y === last) break;
      last = y;
    }
    window.scrollTo(0, 0);
  });
}

async function forceEagerImages(page) {
  await page.evaluate(() => {
    for (const img of document.querySelectorAll('img')) {
      img.loading = 'eager';
      img.decoding = 'sync';
      for (const [from, to] of [['data-src', 'src'], ['data-srcset', 'srcset'], ['data-lazy-src', 'src'], ['data-original', 'src']]) {
        const v = img.getAttribute(from);
        if (v && !img.getAttribute(to)) img.setAttribute(to, v);
      }
    }
    for (const src of document.querySelectorAll('picture source[data-srcset]')) {
      if (!src.srcset) src.srcset = src.getAttribute('data-srcset');
    }
  });
}

async function waitForImages(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let stats;
  while (Date.now() < deadline) {
    stats = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => i.currentSrc || i.src);
      const pending = imgs.filter((i) => !i.complete).map((i) => i.currentSrc || i.src);
      const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src);
      return { total: imgs.length, pending, broken };
    });
    if (stats.pending.length === 0) break;
    await sleep(500);
  }
  await page.evaluate(() => Promise.all([...document.images].map((i) => (i.decode ? i.decode().catch(() => {}) : null))));
  return stats;
}

async function freezeVideos(page) {
  const videos = await page.$$('video');
  for (const v of videos) {
    try {
      await v.scrollIntoViewIfNeeded();
      await v.evaluate(async (el) => {
        el.muted = true;
        if (el.readyState < 2) {
          el.preload = 'auto';
          el.load();
          await new Promise((r) => {
            el.addEventListener('loadeddata', r, { once: true });
            setTimeout(r, 8000);
          });
        }
        el.pause();
      });
      const buf = await v.screenshot({ timeout: 10000 });
      await v.evaluate((el, b64) => {
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${b64}`;
        img.style.width = `${el.getBoundingClientRect().width}px`;
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        img.className = el.className;
        el.replaceWith(img);
      }, buf.toString('base64'));
    } catch (e) {
      console.warn('video capture failed:', e.message);
    }
  }
  return videos.length;
}

async function unstick(page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') el.style.setProperty('position', 'static', 'important');
    }
    if (!document.documentElement.lang) document.documentElement.lang = 'en';
  });
  await page.addStyleTag({
    content: `
      html, body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      img, svg, picture, figure, canvas { max-width: 100% !important; break-inside: avoid; page-break-inside: avoid; }
      img { height: auto; }
      figure { break-inside: avoid; }
      h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
      pre, code, table { break-inside: avoid; white-space: pre-wrap; }
    `,
  });
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const failed = [];
  page.on('requestfailed', (r) => {
    if (r.resourceType() === 'image') failed.push(`${r.url()} (${r.failure()?.errorText})`);
  });

  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  console.log('status', resp && resp.status());
  await forceEagerImages(page);
  await autoScroll(page);
  await forceEagerImages(page);
  await page.waitForLoadState('networkidle').catch(() => {});
  const stats = await waitForImages(page, 60000);
  const nVideos = await freezeVideos(page);
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'screen' });
  await unstick(page);
  await sleep(500);

  const meta = await page.evaluate(() => ({ title: document.title, lang: document.documentElement.lang }));
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    margin: { top: '12mm', bottom: '14mm', left: '10mm', right: '10mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="font-size:8px;width:100%;padding:0 10mm;color:#888;display:flex;justify-content:space-between"><span class="url"></span><span><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>',
    tagged: true,
    outline: true,
  });

  console.log(JSON.stringify({ out, ...meta, images: stats.total, pending: stats.pending, broken: stats.broken, failed, videos: nVideos }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
