const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const url = process.argv[2];
const out = process.argv[3] || 'article.pdf';
const htmlOut = process.argv[4];
if (!url) {
  console.error('usage: node build-article-pdf.cjs <url> [out.pdf] [out.html]');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function expandFaq(page) {
  const n = await page.evaluate(() => {
    const c = document.querySelector('[data-framer-name="Blog content"]');
    const mods = [...c.children].filter((e) => e.querySelector('[data-framer-name="title"]'));
    mods.forEach((m, i) => m.setAttribute('data-faq-idx', i));
    return mods.length;
  });
  const faq = [];
  for (let i = 0; i < n; i++) {
    const mod = `[data-faq-idx="${i}"]`;
    const has = () => page.evaluate((s) => {
      const a = document.querySelector(`${s} [data-framer-name="answer"]`);
      return !!a && a.textContent.trim().length > 0;
    }, mod);
    if (!(await has())) {
      await page.locator(`${mod} [data-framer-name="title"]`).first().click();
      await page.waitForFunction((s) => {
        const a = document.querySelector(`${s} [data-framer-name="answer"]`);
        return !!a && a.textContent.trim().length > 0;
      }, mod, { timeout: 15000 });
    }
    faq.push(await page.evaluate((s) => {
      const m = document.querySelector(s);
      const q = m.querySelector('[data-framer-name="title"] p, [data-framer-name="title"]');
      return { q: q.textContent.trim(), a: m.querySelector('[data-framer-name="answer"]').innerHTML };
    }, mod));
  }
  return faq;
}

async function vimeoPoster(context, id, referer) {
  const p = await context.newPage();
  try {
    await p.goto(`https://player.vimeo.com/video/${id}`, { referer, waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForFunction(() => window.playerConfig && window.playerConfig.video, null, { timeout: 30000 });
    const v = await p.evaluate(() => window.playerConfig.video);
    return { id, poster: `${v.thumbnail_url.split('?')[0]}?mw=1920`, duration: v.duration, width: v.width, height: v.height };
  } finally {
    await p.close();
  }
}

async function extract(page) {
  return page.evaluate(() => {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
    const content = document.querySelector('[data-framer-name="Blog content"]');
    const h1 = document.querySelector('h1');

    const headText = [];
    for (let el = h1; el && headText.length === 0; el = el.parentElement) {
      if (el.innerText && /\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/.test(el.innerText)) headText.push(el.innerText);
    }
    const lines = (headText[0] || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const date = lines.find((l) => /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(l)) || '';
    const category = lines.find((l) => l !== date && l !== h1.innerText.trim() && l.length < 40) || '';

    const hero = [...document.images]
      .filter((i) => !content.contains(i) && i.naturalWidth > 400)
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
    const orig = (i) => {
      const u = new URL(i.currentSrc || i.src, location.href);
      if (/framerusercontent\.com$/.test(u.hostname)) u.search = '';
      return u.href;
    };

    const KEEP = { a: ['href'], img: ['src', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] };
    const clean = (root) => {
      root.querySelectorAll('script,style,svg,button').forEach((e) => e.remove());
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
      const comments = [];
      while (walker.nextNode()) comments.push(walker.currentNode);
      comments.forEach((c) => c.remove());
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const keep = KEEP[el.tagName.toLowerCase()] || [];
        for (const a of [...el.attributes]) if (!keep.includes(a.name)) el.removeAttribute(a.name);
        if (el.tagName === 'A') {
          el.setAttribute('href', abs(el.getAttribute('href') || ''));
        }
      }
      root.querySelectorAll('p,h2,h3,h4,h5').forEach((e) => {
        if (!e.querySelector('img') && e.textContent.replace(/ /g, ' ').trim() === '') e.remove();
      });
      return root;
    };

    const blocks = [];
    const seenVideos = new Set();
    let byline = '';
    const kids = [...content.children];
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      const tag = el.tagName.toLowerCase();
      const text = el.textContent.replace(/ /g, ' ').trim();
      if (!byline && blocks.length === 0 && tag === 'p' && text && text.length < 80) { byline = text; continue; }
      const iframe = el.querySelector('iframe[src*="vimeo.com"]');
      if (iframe) {
        const id = iframe.src.match(/video\/(\d+)/)[1];
        if (!seenVideos.has(id)) { seenVideos.add(id); blocks.push({ type: 'video', id }); }
        continue;
      }
      if (el.getAttribute('data-faq-idx') !== null) { blocks.push({ type: 'faq', idx: +el.getAttribute('data-faq-idx') }); continue; }
      if (tag === 'img') {
        blocks.push({ type: 'html', html: `<figure class="img"><img src="${orig(el)}" alt="${(el.alt || '').replace(/"/g, '&quot;')}"></figure>` });
        continue;
      }
      if (!text && !el.querySelector('img,table')) continue;
      const c = clean(el.cloneNode(true));
      c.querySelectorAll('img').forEach((im, k) => im.setAttribute('src', orig(el.querySelectorAll('img')[k])));
      if (c.tagName === 'FIGURE' && c.querySelector('table')) {
        c.setAttribute('class', 'table');
        const first = c.querySelector('table tr');
        if (first && first.children.length && [...first.children].every((x) => x.tagName === 'TH')) {
          const thead = document.createElement('thead');
          thead.appendChild(first);
          c.querySelector('table').prepend(thead);
        }
      }
      blocks.push({ type: 'html', tag, text, html: c.outerHTML });
    }
    return {
      title: h1.innerText.trim(),
      docTitle: document.title,
      description: (document.querySelector('meta[name="description"]') || {}).content || '',
      date, category, byline,
      hero: hero ? { src: orig(hero), alt: hero.alt || '' } : null,
      blocks,
      videoIds: [...seenVideos],
    };
  });
}

function build(meta, faq, videos, sourceUrl) {
  const vmap = Object.fromEntries(videos.map((v) => [v.id, v]));
  const parts = [];
  let faqOpen = false;
  for (let i = 0; i < meta.blocks.length; i++) {
    const b = meta.blocks[i];
    if (b.type !== 'faq' && faqOpen) { parts.push('</section>'); faqOpen = false; }
    if (b.type === 'video') {
      const v = vmap[b.id];
      parts.push(`<figure class="video"><div class="frame"><img src="${esc(v.poster)}" alt="Video still"><span class="play"></span><span class="dur">${mmss(v.duration)}</span></div><figcaption>Video (${mmss(v.duration)}) — still frame shown; play it in the <a href="${esc(sourceUrl)}">original post</a>.</figcaption></figure>`);
    } else if (b.type === 'faq') {
      if (!faqOpen) { parts.push('<section class="faq">'); faqOpen = true; }
      const f = faq[b.idx];
      parts.push(`<div class="qa"><h4>${esc(f.q)}</h4>${f.a}</div>`);
    } else if (b.tag === 'h5' && /^nuance$/i.test(b.text) && meta.blocks[i + 1] && meta.blocks[i + 1].tag === 'ul') {
      parts.push(`<aside class="nuance"><div class="label">${esc(b.text)}</div>${meta.blocks[i + 1].html}</aside>`);
      i++;
    } else {
      parts.push(b.html);
    }
  }
  if (faqOpen) parts.push('</section>');

  const faqAnswerHtml = parts.join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<meta name="author" content="${esc(meta.byline)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=block" rel="stylesheet">
<style>
@page { size: A4; margin: 18mm 18mm 20mm 18mm; }
:root { --ink: #16181d; --muted: #5d6470; --rule: #d9dce1; --accent: #d6246e; --soft: #f5f6f8; --link: #1f4fd1; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: var(--ink); background: #fff; font: 10.5pt/1.58 "Source Serif 4", "Liberation Serif", serif; hyphens: auto; }
a { color: var(--link); text-decoration: underline; text-decoration-thickness: .5pt; text-underline-offset: 1.5pt; }
strong { font-weight: 600; }
h1, h2, h3, h4, h5, .kicker, .meta, figcaption, table, .nuance .label, .dur { font-family: Inter, "Liberation Sans", sans-serif; }
header.doc { margin: 0 0 8mm; }
.kicker { font-size: 8pt; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin-bottom: 4mm; }
.kicker span + span::before { content: "·"; margin: 0 .6em; color: var(--muted); }
h1 { font-size: 30pt; line-height: 1.08; letter-spacing: -.02em; font-weight: 700; margin: 0 0 4mm; text-wrap: balance; }
.meta { font-size: 9pt; color: var(--muted); display: flex; flex-wrap: wrap; gap: .3em 1.2em; margin-bottom: 1.5mm; }
.meta b { color: var(--ink); font-weight: 600; }
.source { font-family: "JetBrains Mono", monospace; font-size: 7.5pt; color: var(--muted); word-break: break-all; }
.hero { margin: 6mm 0 0; }
.hero img { width: 100%; max-height: 120mm; object-fit: cover; display: block; border-radius: 2mm; }
h2 { font-size: 17pt; line-height: 1.2; letter-spacing: -.01em; font-weight: 700; margin: 9mm 0 3mm; padding-top: 3mm; border-top: 1.5pt solid var(--ink); }
h3 { font-size: 13pt; line-height: 1.25; font-weight: 600; margin: 7mm 0 2.5mm; }
h4 { font-size: 11pt; font-weight: 600; margin: 5mm 0 2mm; }
h2, h3, h4, h5 { break-after: avoid; page-break-after: avoid; }
p { margin: 0 0 2.6mm; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 3mm; padding-left: 5.5mm; }
li { margin: 0 0 1.4mm; }
li > p { margin: 0 0 1mm; }
li ul { margin-top: 1mm; }
code { font: .86em "JetBrains Mono", monospace; background: var(--soft); padding: .1em .3em; border-radius: 2px; }
figure { margin: 4mm 0 5mm; break-inside: avoid; page-break-inside: avoid; }
figure.img img { width: 100%; height: auto; display: block; border: .5pt solid var(--rule); border-radius: 1.5mm; }
figcaption { font-size: 8pt; color: var(--muted); margin-top: 1.8mm; }
figure.video .frame { position: relative; border-radius: 1.5mm; overflow: hidden; border: .5pt solid var(--rule); background: #000; }
figure.video img { width: 100%; height: auto; display: block; }
figure.video .play { position: absolute; left: 50%; top: 50%; width: 15mm; height: 15mm; margin: -7.5mm 0 0 -7.5mm; border-radius: 50%; background: rgba(0,0,0,.62); box-shadow: 0 0 0 1pt rgba(255,255,255,.85); }
figure.video .play::after { content: ""; position: absolute; left: 5.8mm; top: 4.2mm; border-style: solid; border-width: 3.3mm 0 3.3mm 5.2mm; border-color: transparent transparent transparent #fff; }
figure.video .dur { position: absolute; right: 2mm; bottom: 2mm; font-size: 7.5pt; color: #fff; background: rgba(0,0,0,.7); padding: .5mm 1.6mm; border-radius: 1mm; }
figure.table { margin: 4mm 0 6mm; break-inside: auto; page-break-inside: auto; }
table { width: 100%; border-collapse: collapse; font-size: 8.6pt; line-height: 1.45; }
th, td { text-align: left; vertical-align: top; padding: 2mm 2.4mm; border-bottom: .5pt solid var(--rule); }
th { font-weight: 600; background: var(--ink); color: #fff; }
td:first-child { font-weight: 600; width: 17%; color: var(--ink); }
tr:nth-child(even) td { background: var(--soft); }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
td p, th p { margin: 0 0 1.4mm; }
td p:last-child, th p:last-child { margin-bottom: 0; }
td a { word-break: break-word; }
.nuance { break-inside: avoid; page-break-inside: avoid; margin: 3mm 0 5mm; padding: 3mm 4mm 1.5mm; background: var(--soft); border-left: 2pt solid var(--accent); border-radius: 0 1.5mm 1.5mm 0; font-size: 9.6pt; }
.nuance .label { font-size: 7.5pt; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; color: var(--accent); margin-bottom: 1.5mm; }
.nuance ul { margin-bottom: 1.5mm; }
section.faq .qa { padding: 3mm 0 1mm; border-top: .5pt dashed #9aa0aa; break-inside: avoid; page-break-inside: avoid; }
section.faq .qa:last-child { border-bottom: .5pt dashed #9aa0aa; }
section.faq h4 { margin: 0 0 1.5mm; font-size: 10.5pt; }
</style>
</head>
<body>
<header class="doc">
  <div class="kicker"><span>TypeSafe AI Blog</span>${meta.category ? `<span>${esc(meta.category)}</span>` : ''}</div>
  <h1>${esc(meta.title)}</h1>
  <div class="meta">${meta.byline ? `<span><b>${esc(meta.byline)}</b></span>` : ''}${meta.date ? `<span>${esc(meta.date)}</span>` : ''}</div>
  <div class="source">Source: <a href="${esc(sourceUrl)}">${esc(sourceUrl)}</a></div>
  ${meta.hero ? `<figure class="hero"><img src="${esc(meta.hero.src)}" alt="${esc(meta.hero.alt)}"></figure>` : ''}
</header>
<main>
${faqAnswerHtml}
</main>
</body>
</html>`;
}

async function waitImages(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let st;
  while (Date.now() < deadline) {
    st = await page.evaluate(() => {
      const imgs = [...document.images];
      return {
        total: imgs.length,
        pending: imgs.filter((i) => !i.complete).map((i) => i.src),
        broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src),
        sizes: imgs.map((i) => `${i.naturalWidth}x${i.naturalHeight} ${i.src.split('/').pop().slice(0, 40)}`),
      };
    });
    if (!st.pending.length) break;
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  return st;
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
  });
  const page = await context.newPage();
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  if (!resp || !resp.ok()) throw new Error(`load failed: ${resp && resp.status()}`);
  await page.waitForSelector('[data-framer-name="Blog content"]', { timeout: 30000 });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 60000 }).catch(() => {});

  const faq = await expandFaq(page);
  const meta = await extract(page);
  const origin = new URL(url).origin + '/';
  const videos = [];
  for (const id of meta.videoIds) videos.push(await vimeoPoster(context, id, origin));

  const html = build(meta, faq, videos, url);
  if (htmlOut) fs.writeFileSync(htmlOut, html);

  const renderContext = await browser.newContext({ locale: 'en-US', userAgent: 'Mozilla/5.0' });
  const doc = await renderContext.newPage();
  await doc.emulateMedia({ media: 'print' });
  await doc.setContent(html, { waitUntil: 'networkidle', timeout: 120000 });
  await doc.evaluate(() => document.fonts.ready);
  const st = await waitImages(doc, 60000);
  if (st.pending.length || st.broken.length) throw new Error(`images not loaded: ${JSON.stringify(st)}`);
  const fonts = await doc.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight} ${f.style}`));

  const footerTitle = esc(meta.title);
  await doc.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="font-family:Inter,Arial,sans-serif;font-size:7.5px;color:#8a909b;width:100%;padding:0 18mm;display:flex;justify-content:space-between"><span>${footerTitle} — TypeSafe AI Blog</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    tagged: true,
    outline: true,
  });

  console.log(JSON.stringify({
    out: path.resolve(out),
    title: meta.title, date: meta.date, category: meta.category, byline: meta.byline,
    blocks: meta.blocks.length, faq: faq.map((f) => f.q), videos, images: st.sizes, fonts,
  }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
