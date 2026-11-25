# KuranNuru Video Oluşturucu

Bir Kur'an tilavetini paylaşıma hazır bir videoya dönüştüren web uygulaması. Sureyi, ayet aralığını ve kâriyi seçersiniz. Uygulama:

- tilavetten tam olarak o ayetleri keser,
- her ayeti ve kelimeyi sese göre zamanlar,
- videoyu Mushaf metni, meal ve arka planla oluşturur.

Her şey bilgisayarınızda, ücretsiz ve açık araçlarla çalışır; ücretli hiçbir API kullanılmaz.

## Özellikler

- **Ayet bulma:**
  - Kelimeyle arama: Osmanî hattın yazımına takılmadan; bir kelime yanlış ya da eksik olsa da en yakın ayet bulunur.
  - Anlam ve konuyla arama: "sabır", "cennet", "anne" gibi; Arapça, Türkçe ve İngilizce (multilingual-e5).
  - "Bakara 255" ya da "2:255" yazınca doğrudan o ayete gidilir.
  - **Sesle arama:** Mikrofon düğmesine basıp ayeti okursunuz, okuduğunuz ayetler (birkaç ayet de olabilir) bulunur ve seçilir.
- **Ayetlerin tam kesimi:**
  - 210 kârinin tam sure kayıtları kullanılır (mp3quran.net Hafs kayıtları, yedek olarak QuranicAudio). Kâri listesinde anında dinleme (▶), favoriler (★) ve kayıt kalitesi notu vardır.
  - Bazı kâriler için aynı kaydın daha yüksek kaliteli kopyası kullanılır.
  - Kayıtlar CTC zorlamalı hizalama ile ayet ayet kesilir (torchaudio MMS_FA).
  - Kârinin geri dönüp tekrar okuduğu yerler, Kur'an tilavetine göre eğitilmiş bir faster-whisper modeliyle bulunur ve doğrulanır.
- **Kendi sesiniz:** Tek bir alana herkese açık bir YouTube, TikTok veya Instagram bağlantısı yapıştırırsınız (yt-dlp) ya da bir ses veya video dosyası seçer/sürüklersiniz. Bu ses de aynı şekilde hizalanır.
  - **Reels için:** Kısa bir kayıtta (4 dakikaya kadar) hangi sure ve ayetlerin okunduğu sesten bulunur ve kendiliğinden seçilir; ardından ses hazırlanır, ayetler bölünür ve arka plan konur. Uzun bir kayıttan ise sizin seçtiğiniz ayetler kesilir.
- **Tek adımda video:** Yeni projede favori kâri kendiliğinden seçilir, uzun ayetler bölünür ve ayetlerin konusuna uygun bir arka plan konur.
- **Mushaf metni:**
  - Kral Fahd Kompleksi'nin sayfa fontları (QCF v1 2005 / v2 2013), Osmanî hatla Hafs ve başka Arapça fontlar.
  - Okunan kelime, isteğe bağlı olarak kelime kelime vurgulanır.
- **Mealler:**
  - Türkçe: Diyanet İşleri (yeni ve eski), Diyanet Vakfı, Süleyman Ateş, Elmalılı.
  - İngilizce: Saheeh International, The Clear Quran, Pickthall, Yusuf Ali.
  - Arapça tefsir: Müyesser, Celâleyn.
  - Uzun ayetler, sesle eş zamanlı parçalara bölünebilir (LaBSE desteğiyle).
- **Arka planlar:**
  - **Stok kütüphanesi:** Pixabay, isteğe bağlı olarak Pexels. Kütüphane yalnızca doğa manzarası gösterir. İnsan, bina, araç veya hayvan içeren görüntüler yerel görüntü modelleriyle elenir (CLIP + RT-DETR).
  - **Bir kez kullanılan arka plan bir daha gösterilmez:** Dışa aktarılmış bir videoda kullanılan arka plan, kütüphanede bir daha önerilmez. Başka bir kimlikle ya da başka boyutta gelse bile görüntü parmak iziyle tanınır.
  - **Kendi dosyalarınız:** Kendi resminizi veya videonuzu da kullanabilirsiniz.
  - **Efektler:** Karartma, bulanıklık, yavaş yakınlaşma ve kenar gölgesi.
  - Fotoğraflar Real-ESRGAN ile otomatik olarak keskinleştirilir.
  - Kısa videolar yumuşak geçişle döngüye girer.
  - Arka plan önerileri ayetlerin konusuna göre gelir ve en güzelleri öne çıkar (LAION estetik modeli).
- **Çıktı:**
  - Dikey, yatay veya kare; 720p ya da 1080p. Oluşturma sırasında ilerleme gösterilir.
  - Ses, her videoda orijinal kayıttan kayıpsız kesilir (tekrar tekrar sıkıştırma yok).
  - Dışa aktarma arka planda sürer: beklemeden yeni bir videoya başlayabilirsiniz.
  - Videonun altında kopyalanmaya hazır başlık ve sitenin dilinde etiketler (hashtag) bulunur.
- **Projelerim:**
  - Her proje otomatik olarak kaydedilir: ses, zamanlama, arka plan ve metin ayarları.
  - Projeler "Projelerim" altında listelenir.
  - Dışa aktarılan her videonun değişmeyen bir kopyası ayrıca saklanır.
  - Hesap gerekmez.
- **Disk koruması:** Diskte 5 GB'tan az yer kaldığında kaydetme ve dışa aktarma durur. Docker günlüklerinin boyutu sınırlıdır.
- **Hıfz sayfası (`/hifz`):**
  - Ayetler Medine Mushafı'ndaki satırlarıyla, aynı sayfa fontlarıyla, tam ekran gösterilir. Mushafın üstündeki çubuktan ne yapılacağı her an seçilir; alttaki ince çubukta yalnızca o modun araçları durur. Sayfanın boş kenarına dokunmak çubukları gizler.
  - **Ezberle:** metin istenildiği kadar gizlenir (hepsi açık, her kelimenin ilk harfi, bir kelime açık bir kelime gizli, hepsi gizli; dokunulan kelime açılır). Seçilen ayet istenen sayıda dinlenir.
  - **Ezberden oku:** istenen ayetten başlanır, istenildiği an bitirilir; sonuna kadar okunan ayetler tekrar takvimine girer.
  - **Dinle:** kâri okurken okuduğu kelime sayfada yanar; her ayet ya da bütün bölüm tekrarlanır, telkin ve hız seçilir.
  - **Dinle ve tekrarla:** Ayetler, videodaki hizalayıcıyla kârinin kaydından kesilir; her ayetin başı ve sonu sesin kendisinden bulunur (mp3quran'ın ayet zamanlaması birçok kâride saniyelerce kayıyordu). Bir bölüm ilk seferde birkaç saniyede hazırlanır, sonra hazır bekler. Her ayet ve bütün bölüm istenen sayıda tekrarlanır, hız ayarlanır; isteğe bağlı olarak her ayetten sonra ayet uzunluğunda sessizlik bırakılır (telkin). 210 kârinin hepsiyle çalışır.
  - **Ezberden okuma kontrolü (anında):** Siz okurken ses yaklaşık her saniye sunucuya gider. Doğru okunan kelime belirir, yanlış okunan kelime hemen kırmızıya döner (telefonda kısa bir titreşim). Geri dönüp doğru okursanız uyarı kalkar. Bitirince bütün kayıt bir kez daha kontrol edilir. Geri dönüp tekrar etmek hata sayılmaz. Bir kelimeye dokununca o yerdeki kendi sesinizi ve kârinin okuyuşunu dinleyebilirsiniz.
  - **Okuma yolu (2026-11-25):** Okuyucunun metindeki yolu tek bir aramayla bulunur. Geri dönüp tekrar etmek (iki ayet bile) anında anlaşılır, atlanan ayetler fark edilir, her kelime en son okunuşuna göre değerlendirilir. Düzeltilen hata «yanıldı, sonra düzeltti» notu olarak kalır. Şüpheli her ses ayrı ayrı doğrulanır. Uzmanların etiketlediği Iqra'Eval QuranMB.v2 testinde (18 kişi, 1642 okuma) doğru kelimelere yanlış uyarı %24,2'den %8,3'e indi; gerçek hataların %52'si bulunur.
  - Mikrofonun tarayıcı işlemleri (yankı giderme, gürültü bastırma) kapalıdır: tilavetteki uzun meddleri gürültü sanıp kesiyorlardı.
  - Kontrol edilen son 30 okuma, hataları incelemek için yalnızca bu bilgisayarda `backend/data/hifz_recordings/` altında saklanır.
  - **Kur'an kulağı:** Okuma, Kur'an tilavetine özel eğitilmiş Quran Muaalem modeliyle (obadx/muaalem-model-v3_2, yaklaşık 850 saat tilavet) ses ses dinlenir: harfler harekeleriyle, med ve gunne dahil. Model beklenen metni görmeden duyduğunu yazar; böylece iki kez söylenen bir kelime iki kez duyulur ve yanlış bir hareke de fark edilir (ayrı, daha hafif bir uyarı olarak). Şüpheli her kelime aynı modelin kendi olasılıklarıyla yeniden doğrulanır. Kelime sonu, okuyucunun orada durup durmadığına göre değerlendirilir (seste gerçek bir duraklama ya da ayet sonu): durulan yerde vakıf okunuşu doğrudur; vasılda son hareke ve tenvin yazıldığı gibi okunmalı, vasıl hemzesi okunmamalıdır. 97 tilavette metne yerleştirilen hatalarla ölçüldü (2026-11-24): kelime içi hareke 373/377, vasılda kelime sonu harekesi 354/375 (önceden 4/375), yakın harf (س/ص, ذ/ز, ح/ه …) 373/377; doğru okumalarda yanlış hareke uyarısı 3555 kelimede 15 (önceden 12).
  - 9 kârinin 17 kaydında, içine bilerek hata eklenen testte: atlanan kelimelerin 15/17'si, değiştirilenlerin 16/17'si, eklenenlerin 15/17'si bulundu (önceki Whisper + MMS sistemi: 13, 12, 13). Doğru okumada 700 kelimede 7 yanlış uyarı (önceki: 5), telefon kalitesinde 8 (önceki: 14).
  - **Tekrar takvimi:** Her ayet, okuma başarısına göre artan aralıklarla tekrara gelir (SM-2'ye benzer). "Tekrarlarım" kartı bugün tekrar edilecek ayetleri, sure sure ilerlemeyi ve son okumaları gösterir. İlerleme sunucuda tutulur; telefon ve bilgisayar aynı ilerlemeyi görür.

## Altyapı

| Bölüm | Teknoloji |
|---|---|
| Arayüz ve video oluşturma | Next.js 14, React 18, Remotion 4 (başsız Chromium + ffmpeg), Tailwind CSS |
| Sunucu (backend) | FastAPI, PyTorch/torchaudio (CUDA), faster-whisper, transformers, Quran Muaalem + quran-transcript (Kur'an kulağı) |

Veritabanı yoktur: Kur'an metni arayüzle birlikte gelir, projeler dosya olarak kaydedilir.

## Telif hakkı nedeniyle depoda olmayan dosyalar

Aşağıdaki dosyaların yayın hakları sahiplerine aittir. Bu yüzden depoya konmadılar ve `.gitignore` ile dışarıda tutulurlar. **Uygulama bu dosyalar olmadan derlenmez.** Kendi kullanımınız için bunları kaynaklarından edinmeniz gerekir.

| Dosya | İçerik | Kaynak |
|---|---|---|
| `frontend/src/data/translations/` | Diyanet İşleri (yeni), Süleyman Ateş ve Diyanet Vakfı mealleri | `frontend/scripts/build-acikkuran-translations.mjs` ve `frontend/scripts/build-diyanet-vakfi-translation.mjs` betikleri |
| `frontend/public/fonts/2005/`, `frontend/public/fonts/2013/` | QCF v1 ve v2 sayfa fontları | Kral Fahd Mushaf Basım Kompleksi ([fonts.qurancomplex.gov.sa](https://fonts.qurancomplex.gov.sa)) |
| `frontend/public/fonts/uthmanic_hafs_v20.ttf`, `frontend/public/fonts/UthmanTN1 Ver10.otf` | KFGQPC Hafs ve Osman Taha Nesih fontları | Aynı kaynak |
| `frontend/src/data/quran.json`, `frontend/src/data/quran-qcf-v1.json` | Sure listesi ve her ayetin QCF v2 / v1 glif kodları | Quran.com API v4 (`code_v2` / `code_v1` alanları) |
| `frontend/src/data/hifz-words.json` | Hıfz sayfasının kelimeleri: QCF v2 glif kodu, Osmanî ve imlâî yazım, sayfa ve satır | `frontend/scripts/build-hifz-words.mjs` betiği (Quran.com API v4) |
| `backend/data/models/muaalem-model-v3_2/` | Kur'an kulağının model ağırlıkları (MIT, 2.4 GB) | [obadx/muaalem-model-v3_2](https://huggingface.co/obadx/muaalem-model-v3_2) — dosyaları bu klasöre indirin |
| `backend/scripts/segment_align_cases.json` | Meal bölme testinin Diyanet metni içeren örnekleri | Yalnızca `backend/scripts/eval_segment_align.py` için gereklidir |

## Kaynaklar ve lisanslar

- **Kur'an metni** (`frontend/src/data/quran-uthmani.json`): [Tanzil Projesi](https://tanzil.net), değiştirilmeden; alquran.cloud üzerinden alınmıştır.
- **Video fontları:**
  - Amiri, Cairo, Inter, Noto Naskh Arabic, Noto Sans, Poppins, Aref Ruqaa, Sansita, Tajawal: SIL Open Font License 1.1.
  - Aileron: hakları saklı değildir (CC0).
- **Kâri listesi** (`backend/scripts/mp3quran_reciters.json`, `frontend/src/lib/mp3quranReciters.json`): [mp3quran.net](https://mp3quran.net) API'sinden; `backend/scripts/build_reciter_catalog.py` ile oluşturulur.
- **Depoda bulunmayanlar:** Kâri sesleri, internetten alınan mealler ve stok arka planlar uygulama çalışırken kaynaklarından indirilir.

## Gereksinimler

- Docker ve Docker Compose.
- NVIDIA ekran kartı ve [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
  - Hizalayıcı ve arka plan denetimi ekran kartında çalışır.
  - Kart, konteynerlere CDI ile verilir (`nvidia.com/gpu=all`), bu yüzden Toolkit'in CDI tanımı (`/var/run/cdi`) hazır olmalıdır.
  - Ekran kartınız yoksa `docker-compose.yml` içindeki `devices:` girdilerini kaldırın. Her şey yine çalışır, yalnızca hizalama çok daha yavaştır.
- Yaklaşık 20 GB disk alanı. Sunucu imajı CUDA'lı PyTorch içerir. Modeller (~5 GB) ilk kullanımda `backend/data/` klasörüne iner.
- 16 GB RAM önerilir. Konteynerlerin bellek sınırları `docker-compose.yml` içindedir.

## Başlarken

```bash
git clone https://github.com/Asif-Taash/quran-video-creator.git
cd quran-video-creator
```

Ardından yukarıda listelenen, depoda olmayan dosyaları yerlerine koyun.

**1. Ayarlar (isteğe bağlı)**

Stok arka plan kütüphanesi için `frontend/.env.local` dosyasına bir anahtar ekleyin. Ücretsiz anahtar: [pixabay.com/api/docs](https://pixabay.com/api/docs/).

```
PIXABAY_API_KEY=...
# PEXELS_API_KEY=...   (isteğe bağlı ikinci kaynak)
```

- Anahtar yoksa kütüphane bölümü gizlenir; kendi yüklediğiniz dosyalar yine çalışır.
- Bu anahtarları `docker-compose.yml` içine yazmayın. Oradaki boş bir değer, `.env.local` içindekini geçersiz kılar.

**2. Başlatma**

```bash
docker compose up --build
```

İlk derleme biraz sürer (CUDA'lı PyTorch yaklaşık 3 GB).

**3. Arama dizini (bir kez)**

Anlamla arama, sesle arama ve reels kliplerinin tanınması bir dizin kullanır. Diyanet Vakfı meali (`frontend/src/data/translations/diyanet_vakfi.json`, yukarıya bakın) yerindeyken bir kez oluşturun (ekran kartıyla yaklaşık bir dakika):

```bash
mkdir -p backend/data/ayah_search
cp frontend/src/data/translations/diyanet_vakfi.json backend/data/ayah_search/
docker compose exec -T backend python -I scripts/ayah_search.py --build
```

**4. Hıfz sayfasının kelimeleri (bir kez)**

`frontend/src/data/quran.json` yerindeyken (yukarıya bakın), Quran.com'dan kelime listesini indirir ve her ayetin glif kodlarını `quran.json` ile karşılaştırır (birkaç dakika):

```bash
docker compose exec -u 1000:1000 frontend node scripts/build-hifz-words.mjs
```

**5. Açma**

Uygulama [http://localhost:3000](http://localhost:3000) adresinde açılır. Sunucu API belgeleri [http://localhost:8000/docs](http://localhost:8000/docs) adresindedir.

## Proje yapısı

```
frontend/
  src/app/              sayfa ve API yolları (render, drafts, prepare-audio, backgrounds)
  src/components/       video oluşturma sihirbazı, hıfz sayfası (hifz/) ve arayüz
  src/remotion/         videonun kendisi: QuranVideo.tsx (kompozisyon), timing.ts, types.ts
  src/lib/              ortak mantık (kâriler, mealler, stok arka planlar, kullanılmış arka planlar...)
  src/data/             Kur'an metni ve mealler (bir kısmı depoda yok, yukarıya bakın)
  public/fonts/         Mushaf sayfa fontları ve video fontları
  scripts/              meal dosyalarını ve hıfz kelime listesini oluşturan betikler
backend/
  app/routers/          FastAPI uç noktaları (extraction, segmentation, vision, enhance, search, hifz, ai)
  scripts/              quran_aligner.py (geçerli hizalayıcı), ayah_search.py (anlamla arama),
                        recite_search.py (sesle arama ve klip tanıma), quran_ear.py (Kur'an kulağı),
                        hifz_check.py + hifz_judge.py (ezber kontrolü),
                        extract_precise_clip.py (eski
                        Whisper akışı; ALIGN_ENGINE=legacy ve ortak yardımcılar için duruyor),
                        segment_align.py, eval_* betikleri
  data/                 (git dışında) model önbellekleri, indirilen sure sesleri, test sesleri
```

## Notlar

- **Geliştirme modu:** İki konteyner de geliştirme modunda çalışır (`next dev`, `uvicorn --reload`), kod değişiklikleri anında uygulanır.
- **Oluşturulan videolar:** Videolar bellekteki `public/renders` klasörüne (512 MB) yazılır ve yalnızca en yenileri kısa bir süre tutulur. Videoyu indirin, başka hiçbir yerde saklanmaz.
- **Projelerin saklandığı yer:**
  - Proje ayarları `frontend/src/data/drafts` klasöründedir.
  - Proje dosyaları `render_assets` biriminde (volume) durur; hazırlanan sesin bir kopyası da buradadır.
  - Yayımlanmış videolarda kullanılan arka planların kaydı `frontend/src/data/used-backgrounds.json` dosyasındadır.
  - `docker compose down -v` bu birimi siler; yalnızca `docker compose down` onu korur.
