# Ürün Katkı Formu

GitHub bilmeyen kullanıcıların listeye ürün önerebilmesi için web formu.
Bu branch (`form`) yalnızca form kodunu içerir, veritabanı (`main`) etkilenmez.

```
Kullanıcı ─► Form sayfası ─► Cloudflare Worker ─► GitHub API ─► katki/... branch'i + PR
                              (Turnstile + kontroller)              │
                                                                    ▼
                                         Ürün doğrulama Action'ı ─► Siz inceleyip merge edersiniz
```

- Tek gönderimde **en fazla 10 ürün**, hepsi **tek PR** olarak gelir.
- Logo tarayıcıda otomatik küçültülür (≤400 px JPG, ~100 KB) ve `b_img/` klasörüne eklenir.
- Kişisel veri **istenmez ve tutulmaz**.
- Spam koruması: Cloudflare Turnstile + aynı anda en fazla 15 bekleyen form PR'ı.
- Maliyet: Cloudflare Workers ve Turnstile ücretsiz planları yeterli (Workers: günde 100.000 istek).

## Barkod → firma kodu kuralları

Katkıcı paketteki **13 haneli barkodun tamamını** girer (kontrol hanesi doğrulanır). Listeye barkodun kendisi değil, firmayı temsil eden **önek** eklenir:

| Durum | Eklenen | Örnek |
|---|---|---|
| İlk 7 hane listede yok | **7 hane** (firmanın tüm ürünleri) | `8699999…` → `8699999` |
| İlk 7 hanenin içinde 9 haneli kodlar var (küçük firmalara dağıtılmış blok) | **9 hane** | `8697403…` → `869740312` (Danet `869740389` aynı blokta) |
| İlk 7 hane başka bir markada kayıtlı | **9 hane** | `8690120…` → `869012055` (Torku `8690120`) |
| Seçilen kod başka bir üründe birebir kayıtlı | **eklenmez**, PR'da ⚠️ olarak listelenir | `869740389…` → Danet'te kayıtlı |
| Aynı ürünün başka barkodu zaten kapsıyor | tekrar eklenmez | |

- Katkıcı formda her barkodun ne olacağını göndermeden önce görür. Asıl kararı Worker, güncel `main` verisine göre verir.
- 868/869 dışında başlayan barkodlar eklenir ama PR'da 🌐 olarak işaretlenir.
- Doğrulama iş akışı yeni eklenen kodlarda şunları reddeder: 7 veya 9 hane dışı kod, başka üründe birebir bulunan kod, başka ürünün 9 haneli kodunu kapsayan 7 haneli kod. Mevcut kayıtlardaki eski çakışmalara dokunmaz.
- **Uygulama tarafı:** Bu yapının doğru çalışması için uygulamanın okutulan barkoda **en uzun eşleşen kodu** seçmesi gerekir (önce 9 hane, yoksa 7 hane).
- Kurallar `public/barkod.js` dosyasındadır. Form ve Worker aynı dosyayı kullanır.

## Dosyalar

| Dosya | Görev |
|---|---|
| `public/index.html` | Form sayfası |
| `public/barkod.js` | Barkod → firma kodu kuralları (form + Worker ortak) |
| `src/index.js` | Worker: doğrulama, commit, PR açma |
| `wrangler.jsonc` | Cloudflare ayarları (gizli anahtar içermez) |

Doğrulama Action'ı (`.github/workflows/urun-dogrulama.yml` ve `.github/scripts/urun_dogrula.py`) `main` branch'inde olmalıdır, çünkü GitHub PR kontrollerini taban branch'teki iş akışından çalıştırır.

---

## Kurulum (yaklaşık 20 dakika)

### 1. `main` dalını koruyun

**Settings → Rules → Rulesets → New branch ruleset**

- Ruleset name: `main koruma`, Enforcement: **Active**
- Target branches: **Include default branch**
- ✅ Restrict deletions
- ✅ Block force pushes
- ✅ Require a pull request before merging (Required approvals: **0**)
- ✅ Require status checks to pass → `dogrula` (doğrulama PR'ı merge edildikten sonra listede çıkar)
- **Bypass list: boş bırakın**

> Neden bypass listesi boş? Worker'ın kullandığı token sizin adınıza çalışır. Kendinizi bypass listesine eklerseniz token da `main`'e doğrudan yazabilir. Liste boşken token yalnızca yeni branch açıp PR oluşturabilir. Kendi değişikliklerinizi de GitHub'ın web düzenleyicisinden "Commit changes → Create a new branch and start a pull request" ile yapıp hemen merge edebilirsiniz.

### 2. GitHub token oluşturun

**GitHub → Settings (profil) → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

- Token name: `urun-katki-formu`
- Expiration: en fazla 1 yıl (**bitiş tarihini takviminize not edin**)
- Repository access: **Only select repositories → boycot-db**
- Permissions → Repository permissions:
  - **Contents: Read and write**
  - **Pull requests: Read and write**
  - (Metadata: Read-only otomatik gelir)
- Başka hiçbir yetki vermeyin.

Token'ı hiçbir dosyaya, sohbete veya koda yapıştırmayın. Yalnızca 5. adımda Cloudflare'e girin.

### 3. Cloudflare hesabı açın

[dash.cloudflare.com](https://dash.cloudflare.com) üzerinden ücretsiz hesap açın. Kredi kartı gerekmez.

### 4. Turnstile anahtarlarını alın

**Cloudflare → Turnstile → Add widget**

- Widget name: `urun-katki-formu`
- Hostname: `urun-katki-formu.<hesap-alt-alan-adiniz>.workers.dev` (Worker'ı ilk kez yayınladıktan sonra adresi kesinleşir; gerekirse sonra güncelleyin. Kendi alan adınızı kullanırsanız onu da ekleyin.)
- Widget mode: **Managed**

Size **Site Key** (herkese açık) ve **Secret Key** (gizli) verilir. Site Key'i `wrangler.jsonc` içindeki `TURNSTILE_SITE_KEY` değerine yazın (şu anki widget anahtarı zaten girili).

### 5. Worker'ı yayınlayın

**Yöntem A: Bilgisayarınızdan (Node.js 18+ gerekir)**

```bash
git clone -b form https://github.com/turakahmet/boycot-db.git urun-katki-formu
cd urun-katki-formu
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN           # 2. adımdaki token'ı yapıştırın
npx wrangler secret put TURNSTILE_SECRET_KEY   # 4. adımdaki Secret Key
npx wrangler deploy
```

**Yöntem B: Cloudflare paneli üzerinden (bilgisayara kurulum yok)**

1. **Workers & Pages → Create → Import a repository** ile GitHub hesabınızı bağlayın ve `boycot-db` reposunu seçin.
2. Production branch: **`form`**, Deploy command: `npx wrangler deploy`.
3. Yayın sonrası **Worker → Settings → Variables and Secrets** altında `GITHUB_TOKEN` ve `TURNSTILE_SECRET_KEY` değerlerini **Secret** olarak ekleyin.

Bu yöntemde `form` branch'ine her push otomatik yayınlanır.

### 6. Test edin

1. `https://urun-katki-formu.<alt-alan-adiniz>.workers.dev` adresini açın.
2. Örnek bir ürün gönderin. Birkaç saniye içinde repoda `form-katkisi` etiketli bir PR ve yeşil "Ürün doğrulama" kontrolü görmelisiniz.
3. Test PR'ını kapatın, ardından `katki/...` branch'ini silin.

### 7. (İsteğe bağlı) Linki duyurun

`index.md` dosyasına veya uygulamanızın içine form linkini ekleyebilirsiniz.

---

## İnceleme süreci

Her PR'da logo önizlemeli bir tablo, açıklamalar ve kaynak linkleri yer alır.

- **Uygunsa:** "Merge pull request". Ürün anında uygulamaya yansır.
- **Uygun değilse:** "Close pull request". İsterseniz sebebini yorum olarak yazın.
- Merge/close sonrası "Delete branch" butonuyla `katki/...` branch'ini silin. Bunu **Settings → General → Automatically delete head branches** ile otomatikleştirebilirsiniz.

Birden fazla PR aynı anda beklerken birini merge ederseniz, diğerlerinde `all-products.json` dosyasında çakışma (conflict) çıkabilir. GitHub'ın web arayüzünde "Resolve conflicts" ile her iki tarafın kayıtlarını tutup çözebilirsiniz.

## Sınırlar ve ayarlar

`src/index.js` dosyasının başındaki `LIMITS` nesnesinden değiştirilebilir:

| Ayar | Varsayılan |
|---|---|
| `MAX_PRODUCTS` | 10 ürün / gönderim |
| `MAX_OPEN_PRS` | 15 bekleyen form PR'ı |
| `DESC_MIN` / `DESC_MAX` | 30 / 1000 karakter |
| `LOGO_MAX_BYTES` | 120 KB |

Ürün tipleri `URUN_TIPLERI` listesindedir. Yeni bir tip eklerseniz `.github/scripts/urun_dogrula.py` içindeki listeyi de güncelleyin.

## Güvenlik notları

- Token yalnızca Cloudflare'de şifreli "secret" olarak durur, kodda veya repoda yer almaz.
- Token sızdığından şüphelenirseniz GitHub'da hemen iptal edip yenisini oluşturun ve `wrangler secret put GITHUB_TOKEN` ile güncelleyin.
- Doğrulama Action'ı, PR'daki değil `main`'deki doğrulayıcı script'iyle çalışır; bir PR kontrolü değiştirerek atlatamaz.
- `katki/` ile başlayan PR'lar yalnızca `all-products.json` sonuna ekleme yapabilir ve yalnızca yeni `b_img/*.jpg` ekleyebilir. Mevcut kayıtları değiştiren veya başka dosyaya dokunan PR'lar kontrolden geçemez.
- Hata ayrıntıları kullanıcıya gösterilmez, yalnızca Cloudflare Worker loglarına yazılır.
