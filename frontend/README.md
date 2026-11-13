# Arayüz (frontend)

Next.js 14 uygulaması ve Remotion video kompozisyonu. Kurulum için [proje README'sine](../README.md) bakın.

- **Video ve ayarlar:** `src/remotion/` videonun kendisidir. Video hem tarayıcıda (canlı önizleme, `@remotion/player`) hem sunucuda (`src/app/api/video/render/route.ts`, `@remotion/renderer`) oluşturulur. Ayarlarını aynı yoldan aldığı için önizleme ile dışa aktarılan video birbirinden ayrışmaz.
- **Tür denetimi** (lint kurulumu yoktur): `docker compose exec frontend npx tsc --noEmit`
- **`node_modules`:** Paketler imajın içinde kurulur ve konteyner kendi kopyasını kullanır.
  - Düzenleyicinin bilgisayarda tür bilgisini görebilmesi için bu klasörü bir kez dışarı kopyalayın. Kopyalamazsanız her JSX etiketinde "JSX.IntrinsicElements" hatası görünür.
  - `package.json` değişip imaj yeniden derlendiğinde kopyalamayı tekrarlayın:

  ```bash
  docker run --rm -v "$PWD/node_modules":/host-nm --entrypoint sh quran-video-creator-main-frontend \
    -c 'cp -a /app/node_modules/. /host-nm/ && chown -R '"$(id -u):$(id -g)"' /host-nm'
  ```
