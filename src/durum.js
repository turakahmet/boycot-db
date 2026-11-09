/**
 * Gönderim durumu: takip kodu, PR'a gömülen meta veri ve durum sorgusu.
 *
 * Her form PR'ının açıklamasına görünmez bir meta satırı eklenir:
 *   <!-- katki-meta <base64 JSON: {kod, urunler: [ad], dosyalar: [logo dosyası]}> -->
 * Durum, PR'ın durumu + etiketleri + main'deki ürün listesine göre hesaplanır:
 *   - PR açık                         -> inceleniyor
 *   - PR merge edildi, ürün listede    -> eklendi
 *   - PR merge edildi, ürün çıkarılmış -> eklenmedi
 *   - PR merge edilmeden kapatıldı     -> eklenmedi (+ "red: ..." etiketi ve "Yanıt:" yorumu)
 */

export const RET_NEDENLERI = {
  'red: yerli değil': 'Ürün/firma yerli sermayeli değil veya yeterli bilgi bulunamadı.',
  'red: zaten listede': 'Bu ürün başka bir adla listede zaten var.',
  'red: eksik bilgi': 'Açıklama, logo veya barkod bilgisi yetersiz ya da hatalı.',
  'red: kaynak yetersiz': 'Ürünün yerli olduğunu doğrulayan bir kaynak bulunamadı.',
  'red: uygunsuz içerik': 'Gönderim kurallara uygun değil.',
};
const GENEL_RET = 'İnceleme sonucunda listeye eklenmedi.';

// Karışan karakterler (0/O, 1/I/L) yok
const KOD_ALFABE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KOD_UZUNLUK = 8;

export function yeniKod() {
  const b = crypto.getRandomValues(new Uint8Array(KOD_UZUNLUK));
  return Array.from(b, (x) => KOD_ALFABE[x % KOD_ALFABE.length]).join('');
}

/** "ktk-4f7q 9xa2" gibi girişleri "4F7Q9XA2" biçimine getirir; geçersizse null */
export function kodNormal(k) {
  const s = String(k || '').toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${KOD_ALFABE}]{${KOD_UZUNLUK}}$`).test(s) ? s : null;
}

export function kodGoster(k) {
  return `${k.slice(0, 4)}-${k.slice(4)}`;
}

// ---------------------------------------------------------- meta (base64 UTF-8)

function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64Decode(b64) {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function metaYaz(meta) {
  return `<!-- katki-meta ${b64Encode(JSON.stringify(meta))} -->`;
}

export function metaOku(body) {
  const m = /<!-- katki-meta ([A-Za-z0-9+/=]+) -->/.exec(body || '');
  if (!m) return null;
  try {
    const d = JSON.parse(b64Decode(m[1]));
    return d && typeof d.kod === 'string' && Array.isArray(d.urunler) ? d : null;
  } catch { return null; }
}

// ---------------------------------------------------------- ad eşleştirme

function lev(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Normalleştirilmiş sorgu (q) ile ürün adı (s) ne kadar eşleşiyor?
 * 0 = birebir, 1 = içeriyor, 2 = küçük yazım hatası, 3 = başı benziyor, null = eşleşmiyor.
 * Türkçe karakter / büyük-küçük harf / boşluk farkları normalleştirmede zaten yok olur.
 */
export function adSkor(q, s) {
  if (!q || !s) return null;
  if (q === s) return 0;
  if (q.length >= 3 && s.includes(q)) return 1;
  if (s.length >= 4 && q.includes(s)) return 1;
  const tol = q.length <= 5 ? 1 : 2;
  if (Math.abs(s.length - q.length) <= tol && lev(q, s) <= tol) return 2;
  if (q.length >= 4 && s.length > q.length && lev(q, s.slice(0, q.length)) <= 1) return 3;
  return null;
}

// ---------------------------------------------------------- indeks

let bellek = { t: 0, data: null }; // isolate içi önbellek
const yanitBellek = new Map();     // pr no -> { t, yanit }
const TTL_MS = 3 * 60 * 1000;

/** Yeni gönderimden sonra önbelleği boşalt (aynı isolate'te hemen görünsün) */
export function indeksSifirla() { bellek = { t: 0, data: null }; }

/**
 * Tüm form PR'larını ve main'deki ürün listesini okuyup durum indeksini kurar.
 * @param api   index.js'teki GitHub yardımcısı
 * @param norm  ad normalleştirme fonksiyonu
 */
export async function durumIndeksi(env, api, norm, { jsonPath, imgDir, branchPrefix }) {
  if (bellek.data && Date.now() - bellek.t < TTL_MS) return bellek.data;

  const prs = [];
  for (let page = 1; page <= 5; page++) {
    const r = await api(`/pulls?state=all&per_page=100&page=${page}&sort=created&direction=desc`);
    prs.push(...r);
    if (r.length < 100) break;
  }
  const mainText = await api(`/contents/${jsonPath}?ref=${env.BASE_BRANCH || 'main'}`, { raw: true });
  const mevcut = JSON.parse(mainText);
  const listeSlug = new Set(mevcut.map((u) => norm(String(u.urunAdi || ''))));
  const listeLogo = new Set(mevcut.map((u) => String(u.urunLogo || '').split('/').pop()));
  const listede = mevcut.map((u) => ({ ad: String(u.urunAdi || ''), slug: norm(String(u.urunAdi || '')) }));

  const gonderimler = [];
  for (const pr of prs) {
    if (!pr.head || !String(pr.head.ref).startsWith(branchPrefix)) continue;
    const meta = metaOku(pr.body);
    if (!meta) continue;
    const etiketler = (pr.labels || []).map((l) => l.name);
    const red = etiketler.find((n) => RET_NEDENLERI[n]);
    const prDurum = pr.state === 'open' ? 'acik' : pr.merged_at ? 'merge' : 'kapali';
    gonderimler.push({
      no: pr.number,
      kod: meta.kod,
      tarih: pr.created_at,
      sonuc: pr.merged_at || pr.closed_at || null,
      prDurum,
      red: red || null,
      urunler: meta.urunler.map((ad, i) => {
        const dosya = (meta.dosyalar || [])[i];
        const slug = norm(ad);
        let durum = 'inceleniyor';
        if (prDurum === 'merge') durum = listeSlug.has(slug) || (dosya && listeLogo.has(dosya)) ? 'eklendi' : 'eklenmedi';
        else if (prDurum === 'kapali') durum = 'eklenmedi';
        return { ad, slug, durum };
      }),
    });
  }
  bellek = { t: Date.now(), data: { gonderimler, listede } };
  return bellek.data;
}

/** Kapatılan PR'da sahibinin "Yanıt:" ile başlayan son yorumunu getirir */
async function yanitGetir(api, no) {
  const c = yanitBellek.get(no);
  if (c && Date.now() - c.t < TTL_MS) return c.yanit;
  let yanit = null;
  try {
    const yorumlar = await api(`/issues/${no}/comments?per_page=100`);
    for (const y of yorumlar) {
      if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(y.author_association)) continue;
      const m = /^\s*yan[ıi]t\s*:\s*([\s\S]+)/i.exec(y.body || '');
      if (m) yanit = m[1].trim().slice(0, 500);
    }
  } catch { /* yorum alınamazsa yalnızca etiket nedeni gösterilir */ }
  yanitBellek.set(no, { t: Date.now(), yanit });
  return yanit;
}

async function urunCiktisi(api, g, u) {
  const out = { ad: u.ad, durum: u.durum, tarih: g.tarih, sonuc: u.durum === 'inceleniyor' ? null : g.sonuc };
  if (u.durum === 'eklenmedi') {
    out.neden = g.red ? RET_NEDENLERI[g.red] : GENEL_RET;
    const y = await yanitGetir(api, g.no);
    if (y) out.yanit = y;
  }
  return out;
}

/** Bir veya birden fazla takip kodunun durumu */
export async function kodDurumu(idx, api, kodlar) {
  const sonuc = [];
  for (const kod of kodlar) {
    const g = idx.gonderimler.find((x) => x.kod === kod);
    if (!g) { sonuc.push({ kod, bulunamadi: true }); continue; }
    sonuc.push({ kod, tarih: g.tarih, urunler: await Promise.all(g.urunler.map((u) => urunCiktisi(api, g, u))) });
  }
  return sonuc;
}

/** Ürün adıyla arama: gönderimler + listede zaten olanlar */
export async function adDurumu(idx, api, q, limit = 5) {
  const adaylar = [];
  for (const g of idx.gonderimler) {
    for (const u of g.urunler) {
      const s = adSkor(q, u.slug);
      if (s !== null) adaylar.push({ s, g, u });
    }
  }
  adaylar.sort((a, b) => a.s - b.s || String(b.g.tarih).localeCompare(String(a.g.tarih)));
  // Aynı ürün birden fazla gönderildiyse en yenisini göster
  const goruldu = new Set();
  const secilen = [];
  for (const a of adaylar) {
    if (goruldu.has(a.u.slug)) continue;
    goruldu.add(a.u.slug);
    secilen.push(a);
    if (secilen.length >= limit) break;
  }
  const gonderimler = await Promise.all(secilen.map((a) => urunCiktisi(api, a.g, a.u)));

  const listede = idx.listede
    .map((u) => ({ u, s: adSkor(q, u.slug) }))
    .filter((x) => x.s !== null && !goruldu.has(x.u.slug))
    .sort((a, b) => a.s - b.s)
    .slice(0, 3)
    .map((x) => x.u.ad);

  return { gonderimler, listede };
}
