/**
 * Form sayfasındaki durum bölümleri:
 *   - "Gönderimlerim": bu tarayıcıdan yapılan gönderimler (localStorage)
 *   - Sorgu kutusu: ürün adı (Türkçe karakter / yazım hatası toleranslı) veya takip kodu
 *   - #durum=KOD linki: başka cihazdan durum görüntüleme
 */

const KEY = 'urunKatkiGonderimler.v1';
const KOD_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const YENI_MS = 10 * 60 * 1000; // yeni gönderim sunucuda henüz görünmeyebilir

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export const kodGoster = (k) => `${k.slice(0, 4)}-${k.slice(4)}`;
export const kodNormal = (s) => {
  const k = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  return KOD_RE.test(k) ? k : null;
};
export const durumLinki = (kod) => `${location.origin}/#durum=${kod}`;

// ------------------------------------------------------------ yerel kayıt

function oku() {
  try { const d = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(d) ? d : []; }
  catch { return []; }
}
function yaz(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30))); } catch { /* depolama kapalı olabilir */ }
}
export function gonderimKaydet(kod, urunler) {
  const list = oku().filter((g) => g.kod !== kod);
  list.unshift({ kod, tarih: new Date().toISOString(), urunler: urunler || [] });
  yaz(list);
}
function gonderimSil(kod) { yaz(oku().filter((g) => g.kod !== kod)); }

// ------------------------------------------------------------ görünüm

const ETIKET = {
  inceleniyor: ['⏳', 'İnceleniyor', 'st-wait'],
  eklendi: ['✅', 'Eklendi', 'st-ok'],
  eklenmedi: ['❌', 'Eklenmedi', 'st-no'],
};

function tarihYaz(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return ''; }
}

function urunSatiri(u) {
  const [ikon, metin, cls] = ETIKET[u.durum] || ETIKET.inceleniyor;
  const li = el('li', 'st-row');
  const ust = el('div', 'st-top');
  ust.append(el('span', 'st-name', u.ad), el('span', `st-badge ${cls}`, `${ikon} ${metin}`));
  li.append(ust);
  if (u.neden) li.append(el('div', 'st-reason', u.neden));
  if (u.yanit) {
    const q = el('div', 'st-reply');
    q.append(el('strong', null, 'İnceleyenin notu: '), document.createTextNode(u.yanit));
    li.append(q);
  }
  const t = u.sonuc ? `Sonuç: ${tarihYaz(u.sonuc)}` : u.tarih ? `Gönderim: ${tarihYaz(u.tarih)}` : '';
  if (t) li.append(el('div', 'st-date', t));
  return li;
}

async function getir(qs) {
  const r = await fetch(`/api/durum?${qs}`, { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Durum alınamadı.');
  return d;
}

// ------------------------------------------------------------ Gönderimlerim

export async function gonderimlerimiGoster() {
  const alan = $('#myArea');
  const kutu = $('#myList');
  const yerel = oku();
  if (!yerel.length) { alan.classList.add('hidden'); return; }
  alan.classList.remove('hidden');
  kutu.replaceChildren(el('p', 'st-muted', 'Durum yükleniyor…'));

  let sunucu = [];
  try { sunucu = (await getir(`kodlar=${yerel.map((g) => g.kod).join(',')}`)).sonuclar || []; }
  catch (e) { kutu.replaceChildren(el('p', 'st-muted', e.message)); return; }

  kutu.replaceChildren(...yerel.map((g) => {
    const s = sunucu.find((x) => x.kod === g.kod);
    const kart = el('div', 'st-group');
    const bas = el('div', 'st-head');
    const bulundu = s && !s.bulunamadi;
    if (bulundu && s.tarih && new Date(g.tarih).getTime() === 0) { g.tarih = s.tarih; yaz(yerel); }
    const gTarih = new Date(g.tarih).getTime() === 0 ? '' : tarihYaz(g.tarih);
    bas.append(el('span', 'st-code', `Takip kodu ${kodGoster(g.kod)}`), el('span', 'st-muted', gTarih));
    const sil = el('button', 'st-remove', 'Listeden kaldır');
    sil.type = 'button';
    sil.title = 'Yalnızca bu cihazdaki listeden kaldırır';
    sil.addEventListener('click', () => { gonderimSil(g.kod); gonderimlerimiGoster(); });
    bas.append(sil);
    kart.append(bas);

    const ul = el('ul', 'st-list');
    if (bulundu) {
      // sunucudaki ürün adlarını yerel kayda da işle (link ile eklenenler için)
      if (!g.urunler.length) { g.urunler = s.urunler.map((u) => u.ad); yaz(yerel); }
      ul.append(...s.urunler.map(urunSatiri));
    } else if (Date.now() - new Date(g.tarih).getTime() < YENI_MS) {
      ul.append(...(g.urunler.length ? g.urunler : ['Gönderiminiz']).map((ad) => urunSatiri({ ad, durum: 'inceleniyor', tarih: g.tarih })));
    } else {
      ul.append(el('li', 'st-muted', 'Bu takip koduyla bir gönderim bulunamadı.'));
    }
    kart.append(ul);
    return kart;
  }));
}

// ------------------------------------------------------------ sorgu

async function sorgula(metin) {
  const sonuc = $('#lookupResult');
  const girdi = metin.trim();
  if (!girdi) return;
  sonuc.replaceChildren(el('p', 'st-muted', 'Sorgulanıyor…'));
  try {
    const kod = kodNormal(girdi);
    if (kod) {
      const d = await getir(`kod=${kod}`);
      const s = d.sonuclar[0];
      if (!s || s.bulunamadi) { sonuc.replaceChildren(el('p', 'st-muted', 'Bu takip koduyla bir gönderim bulunamadı. Kodu kontrol edin.')); return; }
      gonderimKaydet(kod, s.urunler.map((u) => u.ad));
      const ul = el('ul', 'st-list');
      ul.append(...s.urunler.map(urunSatiri));
      sonuc.replaceChildren(ul);
      gonderimlerimiGoster();
      return;
    }
    const d = await getir(`ad=${encodeURIComponent(girdi)}`);
    const parcalar = [];
    if (d.gonderimler.length) {
      if (d.gonderimler.length > 1) parcalar.push(el('p', 'st-muted', 'Benzer adla birden fazla gönderim bulundu:'));
      const ul = el('ul', 'st-list');
      ul.append(...d.gonderimler.map(urunSatiri));
      parcalar.push(ul);
    }
    if (d.listede.length) {
      parcalar.push(el('p', 'st-listed', `✅ Listede zaten var: ${d.listede.join(', ')}`));
    }
    if (!parcalar.length) {
      parcalar.push(el('p', 'st-muted', 'Bu adla bir gönderim bulunamadı. Yazımı kontrol edin ya da ürünü aşağıdaki formdan önerin.'));
    }
    sonuc.replaceChildren(...parcalar);
  } catch (e) {
    sonuc.replaceChildren(el('p', 'st-error', e.message));
  }
}

// ------------------------------------------------------------ paylaş

export async function linkPaylas(kod, buton) {
  const url = durumLinki(kod);
  const eski = buton.textContent;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Ürün önerimin durumu', text: `Takip kodu: ${kodGoster(kod)}`, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    buton.textContent = 'Link kopyalandı ✓';
  } catch (e) {
    if (e && e.name === 'AbortError') return; // kullanıcı paylaşımı kapattı
    const i = $('#doneLinkText');
    i.classList.remove('hidden');
    i.value = url;
    i.select();
    buton.textContent = 'Linki kopyalayın';
  }
  setTimeout(() => { buton.textContent = eski; }, 2500);
}

// ------------------------------------------------------------ başlat

export function durumBaslat() {
  $('#lookupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sorgula($('#lookupInput').value);
  });

  // #durum=KOD ile gelindiyse kaydet ve göster
  const m = /durum=([A-Za-z0-9-]+)/.exec(location.hash);
  const kod = m && kodNormal(m[1]);
  if (kod) {
    if (!oku().some((g) => g.kod === kod)) {
      const list = oku();
      list.unshift({ kod, tarih: new Date(0).toISOString(), urunler: [] });
      yaz(list);
    }
    history.replaceState(null, '', location.pathname);
    gonderimlerimiGoster().then(() => $('#myArea').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  } else {
    gonderimlerimiGoster();
  }
}
