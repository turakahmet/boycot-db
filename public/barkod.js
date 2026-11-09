/**
 * Barkod -> firma öneki kuralları.
 * Bu dosya hem form sayfasında (önizleme) hem Worker'da (asıl karar) kullanılır.
 *
 * Kullanıcı ürün paketindeki 13 haneli barkodu (EAN-13) girer; listeye barkodun
 * kendisi değil, firmayı temsil eden öneki eklenir:
 *
 *   1. İlk 7 hanenin ("8690120") içinde listede 9 haneli önekler varsa, bu aralık
 *      küçük firmalara 9 haneli olarak dağıtılmış bir bloktur -> 9 hane kullanılır.
 *   2. İlk 7 hane başka bir üründe birebir kayıtlıysa (aynı firma kodu, farklı marka)
 *      -> 9 hane kullanılır.
 *   3. Aksi halde -> 7 hane kullanılır (firmanın tüm ürünlerini kapsar).
 *   4. Seçilen önek başka bir üründe zaten birebir kayıtlıysa veya daha uzun bir öneki
 *      kapsıyorsa -> EKLENMEZ, çakışma olarak bildirilir.
 *
 * Uygulamanın barkod eşleştirirken EN UZUN eşleşen öneki seçmesi gerekir.
 */

export const ONEK_KISA = 7;
export const ONEK_UZUN = 9;
export const MAX_BARKOD = 10; // ürün başına girilebilecek barkod

/** EAN-13 kontrol hanesi doğru mu? */
export function ean13Gecerli(b) {
  if (!/^\d{13}$/.test(b)) return false;
  let t = 0;
  for (let i = 0; i < 12; i++) t += Number(b[i]) * (i % 2 ? 3 : 1);
  return (10 - (t % 10)) % 10 === Number(b[12]);
}

/** Metindeki barkodları ayıklar (boşluk, virgül, satır sonu ile ayrılmış) */
export function barkodlariAyikla(metin) {
  return [...new Set(String(metin || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Mevcut ürün listesinden önek indeksi: onek -> [ürün adları] */
export function onekIndeksi(urunler) {
  const idx = new Map();
  for (const u of urunler || []) {
    for (const o of String(u.barkodNo || '').split(/\s+/).filter(Boolean)) {
      if (!idx.has(o)) idx.set(o, []);
      idx.get(o).push(String(u.urunAdi || ''));
    }
  }
  return idx;
}

function kapsadiklari(idx, onek) {
  // onek ile başlayan, ondan uzun mevcut önekler
  const sonuc = [];
  for (const [o, adlar] of idx) if (o.length > onek.length && o.startsWith(onek)) sonuc.push([o, adlar]);
  return sonuc;
}

/**
 * Tek bir barkod için kararı verir.
 * @returns {{barkod, durum, onek?, ilgili?, mesaj}}
 *   durum: 'gecersiz' | 'yeni7' | 'blok9' | 'firma9' | 'cakisma' | 'kapsaniyor'
 */
export function barkodKarar(barkod, idx, kendiOnekleri = []) {
  if (!/^\d{13}$/.test(barkod))
    return { barkod, durum: 'gecersiz', mesaj: '13 haneli olmalı' };
  if (!ean13Gecerli(barkod))
    return { barkod, durum: 'gecersiz', mesaj: 'Barkod hatalı yazılmış (kontrol hanesi tutmuyor)' };

  const p7 = barkod.slice(0, ONEK_KISA);
  const p9 = barkod.slice(0, ONEK_UZUN);
  const yabanci = !/^86[89]/.test(barkod);

  // Aynı ürün için zaten kapsanıyorsa tekrar ekleme
  const kapsayan = kendiOnekleri.find((o) => barkod.startsWith(o));
  if (kapsayan) return { barkod, durum: 'kapsaniyor', onek: kapsayan, mesaj: `Bu ürünün ${kapsayan} kodu zaten kapsıyor`, yabanci };

  let onek, durum, ilgili;
  const blok = kapsadiklari(idx, p7);
  if (blok.length) {
    onek = p9; durum = 'blok9'; ilgili = blok[0][1][0];
  } else if (idx.has(p7)) {
    onek = p9; durum = 'firma9'; ilgili = idx.get(p7)[0];
  } else {
    onek = p7; durum = 'yeni7';
  }

  // Çakışma: aynı önek başka üründe veya daha uzun bir öneki yutuyor
  if (idx.has(onek))
    return { barkod, durum: 'cakisma', onek, ilgili: idx.get(onek)[0], mesaj: `${onek} kodu "${idx.get(onek)[0]}" ürününde kayıtlı, eklenmeyecek`, yabanci };
  const altlar = kapsadiklari(idx, onek);
  if (altlar.length)
    return { barkod, durum: 'cakisma', onek, ilgili: altlar[0][1][0], mesaj: `${onek} kodu "${altlar[0][1][0]}" ürününün kodunu kapsıyor, eklenmeyecek`, yabanci };

  const mesaj = {
    yeni7: `${onek} firma kodu eklenecek`,
    blok9: `${onek} eklenecek (bu aralıkta 9 haneli firma kodları var, ör. "${ilgili}")`,
    firma9: `${onek} eklenecek (${p7} kodu "${ilgili}" ürününde kayıtlı)`,
  }[durum];
  return { barkod, durum, onek, ilgili, mesaj, yabanci };
}

/**
 * Gönderimdeki tüm ürünlerin barkodlarını sırayla değerlendirir.
 * Önceki ürünlerin eklenecek önekleri sonrakiler için "mevcut" sayılır.
 * @param {Array<{urunAdi, barkodlar: string[]}>} urunler
 * @returns {Array<{onekler: string[], kararlar: object[]}>}
 */
export function gonderimKararlari(mevcutUrunler, urunler) {
  const idx = onekIndeksi(mevcutUrunler);
  return urunler.map((u) => {
    const onekler = [];
    const kararlar = (u.barkodlar || []).map((b) => {
      const k = barkodKarar(b, idx, onekler);
      if (['yeni7', 'blok9', 'firma9'].includes(k.durum)) onekler.push(k.onek);
      return k;
    });
    for (const o of onekler) idx.set(o, [u.urunAdi]);
    return { onekler, kararlar };
  });
}
