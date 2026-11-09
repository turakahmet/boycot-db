#!/usr/bin/env python3
"""
all-products.json doğrulayıcı.

Kullanım:
  python3 .github/scripts/urun_dogrula.py                      # yalnızca dosyanın kendisini kontrol eder
  python3 .github/scripts/urun_dogrula.py --base <sha|branch>  # PR: değişen kayıt ve görselleri de kontrol eder
  python3 .github/scripts/urun_dogrula.py --base main --head-ref katki/xxx  # form PR'ı kuralları

Bağımlılık yok, yalnızca Python 3 standart kütüphanesi.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import unicodedata

JSON_PATH = "all-products.json"
IMG_DIR = "b_img"
ALANLAR = {"urunAdi", "urunAciklamasi", "ulke", "barkodNo", "urunTip", "urunLogo"}
URUN_TIPLERI = {
    "GIDA", "ICECEK", "TEMIZLIK", "GIYIM", "BAKIM", "TEKNOLOJI",
    "MUTFAK_URUNU", "KIRTASIYE", "TEMIZLIK_BAKIM", "MEDYA",
}
BARKOD_RE = re.compile(r"^\s*\d{3,13}(\s+\d{3,13})*\s*$")  # fazla boşluklar tolere edilir
LOGO_RE = re.compile(r"^https://raw\.githubusercontent\.com/[^/]+/[^/]+/refs/heads/main/b_img/([a-z0-9]+\.jpg)$")
MAX_IMG_BYTES = 300 * 1024
FORM_BRANCH_PREFIX = "katki/"

hatalar, uyarilar = [], []


def hata(msg):
    hatalar.append(msg)
    print(f"::error file={JSON_PATH}::{msg}")


def uyari(msg):
    uyarilar.append(msg)
    print(f"::warning::{msg}")


TR = str.maketrans("çğıöşüâîûÇĞIİÖŞÜ", "cgiosuaiucgiiosu")


def slug(s):
    s = s.translate(TR).lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s)


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def oku_json(text, kaynak):
    try:
        veri = json.loads(text)
    except json.JSONDecodeError as e:
        hata(f"{kaynak} geçerli JSON değil: satır {e.lineno}, sütun {e.colno}: {e.msg}")
        return None
    if not isinstance(veri, list):
        hata(f"{kaynak} bir liste ([...]) olmalı")
        return None
    return veri


def kayit_kontrol(i, u):
    ad = u.get("urunAdi") if isinstance(u, dict) else None
    etiket = f"{i + 1}. kayıt ({ad!r})" if ad else f"{i + 1}. kayıt"
    if not isinstance(u, dict):
        hata(f"{etiket}: nesne ({{...}}) olmalı")
        return
    eksik, fazla = ALANLAR - u.keys(), u.keys() - ALANLAR
    if eksik:
        hata(f"{etiket}: eksik alan(lar): {', '.join(sorted(eksik))}")
    if fazla:
        hata(f"{etiket}: tanımsız alan(lar): {', '.join(sorted(fazla))}")
    for k in ALANLAR & u.keys():
        if not isinstance(u[k], str):
            hata(f"{etiket}: '{k}' metin olmalı")
            return
    if not u.get("urunAdi", "").strip():
        hata(f"{etiket}: ürün adı boş")
    if not u.get("urunAciklamasi", "").strip():
        hata(f"{etiket}: açıklama boş")
    if u.get("ulke") != "TR":
        hata(f"{etiket}: ulke 'TR' olmalı")
    if u.get("urunTip") not in URUN_TIPLERI:
        hata(f"{etiket}: geçersiz urunTip {u.get('urunTip')!r}")
    b = u.get("barkodNo", "")
    if b and not BARKOD_RE.match(b):
        hata(f"{etiket}: barkodNo yalnızca boşlukla ayrılmış rakamlar olmalı ({b!r})")
    if not u.get("urunLogo", "").strip():
        hata(f"{etiket}: urunLogo boş")


def yeni_kayit_kontrol(i, u):
    """Yeni eklenen / değişen kayıtlar için ek kontroller."""
    etiket = f"{i + 1}. kayıt ({u.get('urunAdi')!r})"
    m = LOGO_RE.match(u.get("urunLogo", ""))
    if not m:
        hata(f"{etiket}: urunLogo 'https://raw.githubusercontent.com/<kullanici>/<repo>/refs/heads/main/b_img/<ad>.jpg' biçiminde olmalı")
        return
    yol = os.path.join(IMG_DIR, m.group(1))
    if not os.path.isfile(yol):
        hata(f"{etiket}: logo dosyası bulunamadı: {yol}")


def gorsel_kontrol(yol):
    if not re.fullmatch(r"b_img/[a-z0-9]+\.jpg", yol):
        hata(f"{yol}: görsel adı yalnızca küçük harf/rakam içermeli ve .jpg ile bitmeli")
    if not os.path.isfile(yol):
        return
    boyut = os.path.getsize(yol)
    if boyut > MAX_IMG_BYTES:
        hata(f"{yol}: {boyut // 1024} KB, en fazla {MAX_IMG_BYTES // 1024} KB olmalı")
    with open(yol, "rb") as f:
        if f.read(3) != b"\xff\xd8\xff":
            hata(f"{yol}: geçerli bir JPEG dosyası değil")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", help="Karşılaştırılacak taban commit/branch (PR tabanı)")
    ap.add_argument("--head-ref", default="", help="PR'ın kaynak branch adı")
    args = ap.parse_args()

    with open(JSON_PATH, encoding="utf-8") as f:
        veri = oku_json(f.read(), JSON_PATH)
    if veri is None:
        return bitir()

    # 1) Tüm dosya
    for i, u in enumerate(veri):
        kayit_kontrol(i, u)

    gorulen = {}
    for i, u in enumerate(veri):
        if isinstance(u, dict) and isinstance(u.get("urunAdi"), str):
            k = slug(u["urunAdi"])
            if k in gorulen:
                hata(f"{i + 1}. kayıt ({u['urunAdi']!r}) {gorulen[k] + 1}. kayıtla aynı ürün görünüyor")
            gorulen.setdefault(k, i)

    if not args.base:
        return bitir(len(veri))

    # 2) PR farkları
    try:
        taban = oku_json(git("show", f"{args.base}:{JSON_PATH}"), f"taban {JSON_PATH}") or []
    except subprocess.CalledProcessError:
        taban = []
    taban_kayitlar = [json.dumps(u, sort_keys=True, ensure_ascii=False) for u in taban]
    taban_set = set(taban_kayitlar)

    yeni = [(i, u) for i, u in enumerate(veri)
            if isinstance(u, dict) and json.dumps(u, sort_keys=True, ensure_ascii=False) not in taban_set]
    for i, u in yeni:
        yeni_kayit_kontrol(i, u)

    degisen = [l for l in git("diff", "--name-status", f"{args.base}...HEAD").splitlines() if l.strip()]
    for satir in degisen:
        durum, *yollar = satir.split("\t")
        yol = yollar[-1]
        if yol.startswith(IMG_DIR + "/") and durum[0] in "AMR":
            gorsel_kontrol(yol)

    # 3) Form PR'ı ise sıkı kurallar
    if args.head_ref.startswith(FORM_BRANCH_PREFIX):
        for satir in degisen:
            durum, *yollar = satir.split("\t")
            for yol in yollar:
                if yol != JSON_PATH and not re.fullmatch(r"b_img/[a-z0-9]+\.jpg", yol):
                    hata(f"Form PR'ı yalnızca {JSON_PATH} ve b_img/*.jpg değiştirebilir: {yol}")
                if yol.startswith(IMG_DIR + "/") and durum[0] != "A":
                    hata(f"Form PR'ı mevcut görselleri değiştiremez/silemez: {yol}")
        mevcut = [json.dumps(u, sort_keys=True, ensure_ascii=False) for u in veri[:len(taban_kayitlar)]]
        if mevcut != taban_kayitlar:
            hata("Form PR'ı mevcut ürünleri değiştiremez veya silemez, yalnızca sona ekleme yapabilir")

    print(f"Yeni/değişen kayıt: {len(yeni)} | Değişen dosya: {len(degisen)}")
    if yeni:
        ozet = "\n".join(f"- {u.get('urunAdi')} ({u.get('urunTip')})" for _, u in yeni)
        yaz_ozet(f"### Yeni / değişen ürünler\n{ozet}\n")
    return bitir(len(veri))


def yaz_ozet(md):
    p = os.environ.get("GITHUB_STEP_SUMMARY")
    if p:
        with open(p, "a", encoding="utf-8") as f:
            f.write(md + "\n")


def bitir(adet=None):
    if hatalar:
        yaz_ozet(f"## ❌ {len(hatalar)} hata\n" + "\n".join(f"- {h}" for h in hatalar))
        print(f"\n{len(hatalar)} hata bulundu.")
        return 1
    yaz_ozet(f"## ✅ Doğrulama başarılı ({adet} ürün)")
    print(f"OK - {adet} ürün")
    return 0


if __name__ == "__main__":
    sys.exit(main())
