# KuranNuru Video Oluşturucu

Bir Kur'an tilavetini paylaşıma hazır bir videoya dönüştüren web uygulaması. Sureyi, ayet aralığını ve kâriyi seçersiniz. Uygulama:

- tilavetten tam olarak o ayetleri keser,
- her ayeti ve kelimeyi sese göre zamanlar,
- videoyu Mushaf metni, meal ve arka planla oluşturur.

Her şey bilgisayarınızda, ücretsiz ve açık araçlarla çalışır; ücretli hiçbir API kullanılmaz.

## Özellikler

- **Ayetlerin tam kesimi:**
  - 26 kârinin tam sure kayıtları kullanılır (mp3quran.net, yedek olarak QuranicAudio). Murattal ve mücevved kayıtlar ayrı listelenir.
  - Kayıtlar CTC zorlamalı hizalama ile ayet ayet kesilir (torchaudio MMS_FA).
  - Kârinin geri dönüp tekrar okuduğu yerler, Kur'an tilavetine göre eğitilmiş bir faster-whisper modeliyle bulunur ve doğrulanır.
- **Kendi sesiniz:** Kendi kaydınızı yükleyebilir ya da herkese açık bir YouTube, TikTok veya Instagram videosunun bağlantısını yapıştırabilirsiniz (yt-dlp). Bu ses de aynı şekilde hizalanır.
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
- **Çıktı:** Dikey, yatay veya kare; 720p ya da 1080p. Oluşturma sırasında ilerleme gösterilir.
- **Projelerim:**
  - Her proje otomatik olarak kaydedilir: ses, zamanlama, arka plan ve metin ayarları.
  - Projeler "Projelerim" altında listelenir.
  - Dışa aktarılan her videonun değişmeyen bir kopyası ayrıca saklanır.
  - Hesap gerekmez.
- **Disk koruması:** Diskte 5 GB'tan az yer kaldığında kaydetme ve dışa aktarma durur. Docker günlüklerinin boyutu sınırlıdır.

## Altyapı

| Bölüm | Teknoloji |
|---|---|
| Arayüz ve video oluşturma | Next.js 14, React 18, Remotion 4 (başsız Chromium + ffmpeg), Tailwind CSS |
| Sunucu (backend) | FastAPI, PyTorch/torchaudio (CUDA), faster-whisper, transformers |

Veritabanı yoktur: Kur'an metni arayüzle birlikte gelir, projeler dosya olarak kaydedilir.

## Telif hakkı nedeniyle depoda olmayan dosyalar

Aşağıdaki dosyaların yayın hakları sahiplerine aittir. Bu yüzden depoya konmadılar ve `.gitignore` ile dışarıda tutulurlar. **Uygulama bu dosyalar olmadan derlenmez.** Kendi kullanımınız için bunları kaynaklarından edinmeniz gerekir.

| Dosya | İçerik | Kaynak |
|---|---|---|
| `frontend/src/data/translations/` | Diyanet İşleri (yeni), Süleyman Ateş ve Diyanet Vakfı mealleri | `frontend/scripts/build-acikkuran-translations.mjs` ve `frontend/scripts/build-diyanet-vakfi-translation.mjs` betikleri |
| `frontend/public/fonts/2005/`, `frontend/public/fonts/2013/` | QCF v1 ve v2 sayfa fontları | Kral Fahd Mushaf Basım Kompleksi ([fonts.qurancomplex.gov.sa](https://fonts.qurancomplex.gov.sa)) |
| `frontend/public/fonts/uthmanic_hafs_v20.ttf`, `frontend/public/fonts/UthmanTN1 Ver10.otf` | KFGQPC Hafs ve Osman Taha Nesih fontları | Aynı kaynak |
| `frontend/src/data/quran.json`, `frontend/src/data/quran-qcf-v1.json` | Sure listesi ve her ayetin QCF v2 / v1 glif kodları | Quran.com API v4 (`code_v2` / `code_v1` alanları) |
| `backend/scripts/segment_align_cases.json` | Meal bölme testinin Diyanet metni içeren örnekleri | Yalnızca `backend/scripts/eval_segment_align.py` için gereklidir |

## Kaynaklar ve lisanslar

- **Kur'an metni** (`frontend/src/data/quran-uthmani.json`): [Tanzil Projesi](https://tanzil.net), değiştirilmeden; alquran.cloud üzerinden alınmıştır.
- **Video fontları:**
  - Amiri, Cairo, Inter, Noto Naskh Arabic, Noto Sans, Poppins, Aref Ruqaa, Sansita, Tajawal: SIL Open Font License 1.1.
  - Aileron: hakları saklı değildir (CC0).
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

**3. Açma**

Uygulama [http://localhost:3000](http://localhost:3000) adresinde açılır. Sunucu API belgeleri [http://localhost:8000/docs](http://localhost:8000/docs) adresindedir.

## Proje yapısı

```
frontend/
  src/app/              sayfa ve API yolları (render, drafts, prepare-audio, backgrounds)
  src/components/       video oluşturma sihirbazı ve arayüz
  src/remotion/         videonun kendisi: QuranVideo.tsx (kompozisyon), timing.ts, types.ts
  src/lib/              ortak mantık (kâriler, mealler, stok arka planlar, kullanılmış arka planlar...)
  src/data/             Kur'an metni ve mealler (bir kısmı depoda yok, yukarıya bakın)
  public/fonts/         Mushaf sayfa fontları ve video fontları
  scripts/              meal dosyalarını oluşturan betikler
backend/
  app/routers/          FastAPI uç noktaları (extraction, segmentation, vision, enhance, ai)
  scripts/              quran_aligner.py (geçerli hizalayıcı), extract_precise_clip.py (eski
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
