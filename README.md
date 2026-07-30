# WhatsApp Toplu Mesaj Gönderici

Excel dosyalarındaki sipariş verilerini otomatik okuyan, dinamik **mesaj şablonlarıyla** müşterilere WhatsApp üzerinden tek tıkla **toplu ve otomatik mesaj** göndermenizi sağlayan modern web tabanlı yönetim paneli.

![Python](https://img.shields.io/badge/Python-3.10+-blue.svg)
![FastAPI](https://img.shields.io/badge/FastAPI-0.121+-009688.svg)
![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)
![Baileys](https://img.shields.io/badge/WhatsApp-Baileys-25D366.svg)
![Docker](https://img.shields.io/badge/Docker-Supported-blue)

---

## Öne Çıkan Özellikler

- **Otomatik & Toplu Gönderim:** İster tekli ister filtreleme ve toplu seçim yaparak müşterilerinize şablonlarla otomatik WhatsApp mesajı gönderin.
- **Excel Sipariş İçe Aktarma:** `.xlsx` ve `.xls` formatındaki sipariş listelerini tek tıkla yükleyin.
- **Dinamik Mesaj Şablonları:** Müşteri adı, sipariş tutarı, kargo detayları gibi değişkenlerle (`{Ad}`, `{SiparisNo}`) kişiselleştirilmiş mesajlar hazırlayın.
- **QR Kod ile Kolay WhatsApp Bağlantısı:** Node.js **Baileys** kütüphanesi altyapısıyla WhatsApp hesabınızı anında bağlayın.
- **Canlı Durum Takibi:** Gönderim süreçlerini (Başarılı, Bekliyor, Hatalı) anlık takip edin.
- **Profil & Şablon Yönetimi:** Farklı mağaza veya iş süreçleri için özel profiller oluşturun.

---

## Teknolojiler

- **Backend:** Python (FastAPI, Uvicorn, Pandas)
- **WhatsApp Servisi:** Node.js, Baileys, Express
- **Frontend:** HTML, CSS, JavaScript
- **Konteynerizasyon:** Docker

---

## 📸 Ekran Görüntüleri

| Ana Sayfa | Gizlenen Siparişler |
|:-----------------:|:-------------------:|
| <img src="public/site_gorselleri/1- Ana Sayfa.png" alt="Ana Sayfa" width="400"> | <img src="public/site_gorselleri/2- Gizlenen Siparişler.png" alt="Gizlenen Siparişler" width="400"> |

| Profiller | Dosya Yönetimi |
|:-----------------:|:-------------------:|
| <img src="public/site_gorselleri/3- Profiller.png" alt="Profiller" width="400"> | <img src="public/site_gorselleri/4- Excel Dosyaları Yönetimi.png" alt="Dosya Yönetimi" width="400"> |


---

## Hızlı Başlangıç


#### WhatsApp Servisi
```bash
cd whatsapp-service
npm install
```

#### Python Sunucusu 
```bash
# Bağımlılıkları yükleyin
pip install -r public/requirements.txt
```
#### Sunucuyu başlatın
```bash
python public/server.py
```

> **Windows Kullanıcıları:** Root dizinindeki `start.bat` dosyasına çift tıklayarak tüm servisleri tek tıkla başlatabilirsiniz.

> **MacOS Kullanıcıları:** Root dizinindeki `start.command` dosyasına çift tıklayarak tüm servisleri tek tıkla başlatabilirsiniz.

Servisler başladığında tarayıcınızda **`http://127.0.0.1:8000/`** adresini açabilirsiniz.

---

## Kullanım Rehberi

1. **Bağlantı Kurun:** Arayüzdeki QR kodu WhatsApp mobil uygulamanızdan okutun.
2. **Profil Seçin veya Oluşturun:** Panel varsayılan olarak **Naturan** profili ile açılır; ihtiyacınıza göre yeni mağaza/iş profilleri oluşturabilir veya değiştirebilirsiniz.
3. **Excel Yükleyin:** Sipariş listenizi sürükleyip bırakın veya seçin.
4. **Şablon Oluşturun:** Mesaj taslağınızı dinamik değişkenlerle (`{Ad}`, `{Tutar}` vs.) özelleştirin.
5. **Gönderin:** Gönderilecek siparişleri seçip otomatik toplu gönderimi başlatın.

---

## Geliştirici

**Ali Kaçar**

[![Instagram](https://img.shields.io/badge/Instagram-E4405F?logo=instagram&logoColor=white)](https://www.instagram.com/alikacar23/)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/alikacar23/)
[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/AliKacarr)
[![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)](https://www.youtube.com/@alikacardev)

[alikacardev@gmail.com](mailto:alikacardev@gmail.com)

---

## Lisans

Bu proje [MIT Lisansı](LICENSE.txt) ile lisanslanmıştır.