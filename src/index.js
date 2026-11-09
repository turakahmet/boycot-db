/**
 * Ürün Katkı Formu - Cloudflare Worker
 *
 * Form sayfası (public/) statik olarak sunulur.
 * POST /api/submit: Turnstile doğrular, ürünleri kontrol eder, yeni bir branch'e
 * tek commit atar (all-products.json + b_img/*.jpg) ve PR açar.
 *
 * Gizli değişkenler (koda YAZILMAZ, `wrangler secret put` ile girilir):
 *   GITHUB_TOKEN          - yalnızca bu repoya Contents RW + Pull requests RW yetkili fine-grained token
 *   TURNSTILE_SECRET_KEY  - Cloudflare Turnstile gizli anahtarı
 * Normal değişkenler (wrangler.jsonc > vars):
 *   GITHUB_OWNER, GITHUB_REPO, BASE_BRANCH, TURNSTILE_SITE_KEY
 */

export const LIMITS = {
  MAX_PRODUCTS: 10,          // tek gönderimde en fazla ürün
  MAX_OPEN_PRS: 15,          // bekleyen form PR'ı bu sayıyı geçerse yeni gönderim alınmaz
  NAME_MAX: 60,
  DESC_MIN: 30,
  DESC_MAX: 1000,
  SOURCE_MAX: 300,
  LOGO_MAX_BYTES: 120 * 1024, // tarayıcı ~100 KB altına küçültür
  BODY_MAX_BYTES: 2 * 1024 * 1024,
};

export const URUN_TIPLERI = [
  'GIDA', 'ICECEK', 'TEMIZLIK', 'GIYIM', 'BAKIM', 'TEKNOLOJI',
  'MUTFAK_URUNU', 'KIRTASIYE', 'TEMIZLIK_BAKIM', 'MEDYA',
];

const BRANCH_PREFIX = 'katki/';
const PR_LABEL = 'form-katkisi';
const JSON_PATH = 'all-products.json';
const IMG_DIR = 'b_img';

// ---------------------------------------------------------------- yardımcılar

const TR_MAP = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'i̇': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };

export function slugify(name) {
  return name
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]|i̇/g, (c) => TR_MAP[c] || c)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Tekrar kontrolü için ad normalleştirme ("Ülker A.Ş." ~ "ulker a s") */
export function normName(name) {
  return slugify(name);
}

function clean(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** base64 JPEG'in gerçek byte boyutu */
function b64Bytes(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Tek ürünü doğrular ve temizlenmiş halini döner.
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateProduct(p, index) {
  const no = `${index + 1}. ürün`;
  if (!p || typeof p !== 'object') return { ok: false, error: `${no}: geçersiz kayıt` };

  const urunAdi = clean(p.urunAdi);
  const urunAciklamasi = clean(p.urunAciklamasi);
  const barkodNo = clean(p.barkodNo);
  const urunTip = clean(p.urunTip);
  const kaynak = clean(p.kaynak);
  const logo = typeof p.logo === 'string' ? p.logo.replace(/^data:image\/jpeg;base64,/, '') : '';

  if (!urunAdi || urunAdi.length > LIMITS.NAME_MAX) return { ok: false, error: `${no}: ürün adı 1-${LIMITS.NAME_MAX} karakter olmalı` };
  if (!slugify(urunAdi)) return { ok: false, error: `${no}: ürün adında harf veya rakam olmalı` };
  if (urunAciklamasi.length < LIMITS.DESC_MIN || urunAciklamasi.length > LIMITS.DESC_MAX)
    return { ok: false, error: `${no}: açıklama ${LIMITS.DESC_MIN}-${LIMITS.DESC_MAX} karakter olmalı` };
  if (barkodNo && !/^\d{3,13}( \d{3,13})*$/.test(barkodNo))
    return { ok: false, error: `${no}: barkod önekleri yalnızca rakam olmalı, birden fazlaysa boşlukla ayrılmalı` };
  if (!URUN_TIPLERI.includes(urunTip)) return { ok: false, error: `${no}: geçersiz ürün tipi` };
  if (kaynak && (kaynak.length > LIMITS.SOURCE_MAX || !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(kaynak)))
    return { ok: false, error: `${no}: kaynak geçerli bir http(s) bağlantısı olmalı` };
  if (!logo || !/^[A-Za-z0-9+/]+={0,2}$/.test(logo) || !logo.startsWith('/9j/'))
    return { ok: false, error: `${no}: logo JPEG olarak yüklenemedi, lütfen tekrar seçin` };
  if (b64Bytes(logo) > LIMITS.LOGO_MAX_BYTES) return { ok: false, error: `${no}: logo çok büyük` };

  return { ok: true, value: { urunAdi, urunAciklamasi, barkodNo, urunTip, kaynak, logo } };
}

/** Bir ürün kaydını dosyadaki biçimle (4/8 boşluk girinti) yazar */
export function formatEntry(entry) {
  const lines = Object.entries(entry).map(([k, v]) => `        ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `    {\n${lines.join(',\n')}\n    }`;
}

/**
 * Yeni kayıtları dosyanın sonuna, mevcut metni ve biçimi bozmadan ekler.
 * Böylece PR diff'i yalnızca eklenen satırları gösterir.
 */
export function appendEntries(fileText, entries) {
  const closing = fileText.lastIndexOf(']');
  if (closing === -1) throw new Error('all-products.json beklenen biçimde değil');
  const lastBrace = fileText.lastIndexOf('}', closing);
  const added = entries.map(formatEntry).join(',\n');
  if (lastBrace === -1) {
    // boş liste
    return `[\n${added}\n]\n`;
  }
  return fileText.slice(0, lastBrace + 1) + ',\n' + added + fileText.slice(lastBrace + 1);
}

function mdCell(s) {
  // tablo hücresi: |, satır sonu ve @ (gereksiz bildirim) etkisizleştirilir
  return String(s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/@/g, '@\u200b').replace(/</g, '&lt;');
}

export function buildPrBody(items, commitSha, env) {
  const raw = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${commitSha}`;
  const rows = items.map((it, i) =>
    `| ${i + 1} | <img src="${raw}/${IMG_DIR}/${it.file}" width="64"> | ${mdCell(it.urunAdi)} | ${mdCell(it.urunTip)} | ${mdCell(it.barkodNo || '-')} | ${it.kaynak ? `[kaynak](${encodeURI(it.kaynak).replace(/\)/g, '%29')})` : '-'} |`);
  const details = items.map((it, i) => `**${i + 1}. ${mdCell(it.urunAdi)}**\n> ${mdCell(it.urunAciklamasi)}`);
  return [
    'Bu PR web formu üzerinden otomatik oluşturuldu. Gönderen kişiye ait kişisel veri tutulmamaktadır.',
    '',
    '| # | Logo | Ürün | Tip | Barkod | Kaynak |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '### Açıklamalar',
    ...details,
    '',
    '### İnceleme kontrol listesi',
    '- [ ] Ürünler gerçekten listeye uygun mu? (kaynak kontrol edildi)',
    '- [ ] Logolar doğru ve uygun mu?',
    '- [ ] Açıklamalarda hata / uygunsuz içerik yok',
  ].join('\n');
}

// ------------------------------------------------------------------ GitHub

function gh(env) {
  const base = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  return async (path, { method = 'GET', body, raw = false } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'urun-katki-formu',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitHub ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return raw ? res.text() : res.json();
  };
}

async function verifyTurnstile(token, ip, env) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

// ---------------------------------------------------------------- handler

class UserError extends Error {}

export async function handleSubmit(request, env) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > LIMITS.BODY_MAX_BYTES) throw new UserError('Gönderim çok büyük. Daha az ürünle tekrar deneyin.');

  let payload;
  try { payload = await request.json(); } catch { throw new UserError('Geçersiz istek.'); }

  if (!(await verifyTurnstile(payload.turnstileToken, request.headers.get('CF-Connecting-IP'), env)))
    throw new UserError('Robot doğrulaması başarısız. Sayfayı yenileyip tekrar deneyin.');

  const list = Array.isArray(payload.products) ? payload.products : [];
  if (list.length === 0) throw new UserError('En az bir ürün ekleyin.');
  if (list.length > LIMITS.MAX_PRODUCTS) throw new UserError(`Tek seferde en fazla ${LIMITS.MAX_PRODUCTS} ürün gönderebilirsiniz.`);

  const products = list.map((p, i) => {
    const r = validateProduct(p, i);
    if (!r.ok) throw new UserError(r.error);
    return r.value;
  });

  const api = gh(env);

  // Spam koruması: bekleyen form PR'ı sayısı
  const open = await api('/pulls?state=open&per_page=100');
  const pending = open.filter((pr) => pr.head && pr.head.ref.startsWith(BRANCH_PREFIX)).length;
  if (pending >= LIMITS.MAX_OPEN_PRS)
    throw new UserError('Şu anda incelenmeyi bekleyen çok fazla gönderim var. Lütfen birkaç gün sonra tekrar deneyin.');

  const baseBranch = env.BASE_BRANCH || 'main';
  const ref = await api(`/git/ref/heads/${baseBranch}`);
  const baseSha = ref.object.sha;
  const baseCommit = await api(`/git/commits/${baseSha}`);

  const [fileText, imgList] = await Promise.all([
    api(`/contents/${JSON_PATH}?ref=${baseSha}`, { raw: true }),
    api(`/contents/${IMG_DIR}?ref=${baseSha}`),
  ]);

  let existing;
  try { existing = JSON.parse(fileText); } catch { throw new Error('Mevcut all-products.json okunamadı'); }

  // Tekrar kontrolü: mevcut liste + gönderimin kendi içi
  const seen = new Set(existing.map((e) => normName(String(e.urunAdi || ''))));
  const usedFiles = new Set(imgList.map((f) => f.name.toLowerCase()));
  const items = [];
  for (const p of products) {
    const key = normName(p.urunAdi);
    if (seen.has(key)) throw new UserError(`"${p.urunAdi}" zaten listede veya bu gönderimde iki kez var.`);
    seen.add(key);

    let file = `${slugify(p.urunAdi)}.jpg`;
    for (let n = 2; usedFiles.has(file); n++) file = `${slugify(p.urunAdi)}${n}.jpg`;
    usedFiles.add(file);
    items.push({ ...p, file });
  }

  const logoBase = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/refs/heads/${baseBranch}/${IMG_DIR}`;
  const entries = items.map((it) => ({
    urunAdi: it.urunAdi,
    urunAciklamasi: it.urunAciklamasi,
    ulke: 'TR',
    barkodNo: it.barkodNo,
    urunTip: it.urunTip,
    urunLogo: `${logoBase}/${it.file}`,
  }));
  const newText = appendEntries(fileText, entries);
  JSON.parse(newText); // güvenlik: sonuç geçerli JSON olmalı

  // Blob'lar
  const jsonBlob = await api('/git/blobs', { method: 'POST', body: { content: newText, encoding: 'utf-8' } });
  const imgBlobs = await Promise.all(items.map((it) =>
    api('/git/blobs', { method: 'POST', body: { content: it.logo, encoding: 'base64' } })));

  const tree = await api('/git/trees', {
    method: 'POST',
    body: {
      base_tree: baseCommit.tree.sha,
      tree: [
        { path: JSON_PATH, mode: '100644', type: 'blob', sha: jsonBlob.sha },
        ...items.map((it, i) => ({ path: `${IMG_DIR}/${it.file}`, mode: '100644', type: 'blob', sha: imgBlobs[i].sha })),
      ],
    },
  });

  const names = items.map((it) => it.urunAdi);
  const title = items.length === 1
    ? `Ürün önerisi: ${names[0]}`
    : `Ürün önerisi: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''} (${names.length} ürün)`;

  const commit = await api('/git/commits', {
    method: 'POST',
    body: { message: `${title}\n\nWeb formu üzerinden gönderildi.`, tree: tree.sha, parents: [baseSha] },
  });

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const branch = `${BRANCH_PREFIX}${stamp}-${crypto.randomUUID().slice(0, 6)}`;
  await api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });

  const pr = await api('/pulls', {
    method: 'POST',
    body: { title: title.slice(0, 250), head: branch, base: baseBranch, body: buildPrBody(items, commit.sha, env) },
  });

  try {
    await api(`/issues/${pr.number}/labels`, { method: 'POST', body: { labels: [PR_LABEL] } });
  } catch { /* etiket isteğe bağlı */ }

  return { prUrl: pr.html_url, prNumber: pr.number, count: items.length };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({
        siteKey: env.TURNSTILE_SITE_KEY,
        owner: env.GITHUB_OWNER,
        repo: env.GITHUB_REPO,
        branch: env.BASE_BRANCH || 'main',
        limits: LIMITS,
        urunTipleri: URUN_TIPLERI,
      });
    }

    if (url.pathname === '/api/submit') {
      if (request.method !== 'POST') return json({ error: 'Yalnızca POST' }, 405);
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ error: 'İzin verilmeyen kaynak' }, 403);
      if (!(request.headers.get('Content-Type') || '').includes('application/json'))
        return json({ error: 'Geçersiz istek' }, 415);
      try {
        return json({ ok: true, ...(await handleSubmit(request, env)) });
      } catch (e) {
        if (e instanceof UserError) return json({ error: e.message }, 400);
        console.error(e); // Cloudflare loglarında görünür; kullanıcıya ayrıntı verilmez
        return json({ error: 'Beklenmeyen bir hata oluştu. Lütfen daha sonra tekrar deneyin.' }, 500);
      }
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'Bulunamadı' }, 404);

    // Diğer her şey statik dosya (public/)
    return env.ASSETS.fetch(request);
  },
};
