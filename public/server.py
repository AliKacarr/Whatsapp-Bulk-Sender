import os
import sys
import pandas as pd
import uvicorn
from typing import List, Optional
from fastapi import FastAPI, BackgroundTasks, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import webbrowser
import time
import threading
import json
import re
import unicodedata
import httpx
import subprocess
import atexit

# Windows'ta Türkçe karakter desteği için stdout/stderr'i UTF-8 yap
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr.encoding != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

app = FastAPI(title="WhatsApp Excel Order Sender API")

# Allow CORS for local development if needed
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PUBLIC_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE_DIR = os.path.abspath(os.path.join(PUBLIC_DIR, ".."))
PROFILES_FILE = os.path.join(PUBLIC_DIR, "profiles.json")

# In-memory status store with file persistence
# format: { order_id: { "status": "pending|sending|sent|failed", "error": "" } }
sending_status = {}
status_lock = threading.Lock()
send_lock = threading.Lock()

STATUS_DIR = os.path.join(PUBLIC_DIR, "status_data")
os.makedirs(STATUS_DIR, exist_ok=True)
STATUS_FILE = os.path.join(PUBLIC_DIR, "sending_status.json")

WHATSAPP_SERVICE_URL = "http://127.0.0.1:3001"

profiles_lock = threading.Lock()
profiles = []

def default_profiles():
    return [
        {"id": "naturan", "name": "Naturan", "directory": "Naturan"},
    ]

def save_profiles():
    with open(PROFILES_FILE, "w", encoding="utf-8") as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)

def load_profiles():
    global profiles
    try:
        if os.path.exists(PROFILES_FILE):
            with open(PROFILES_FILE, "r", encoding="utf-8") as f:
                profiles = json.load(f)
        else:
            profiles = default_profiles()
            save_profiles()
        for profile in profiles:
            os.makedirs(os.path.join(WORKSPACE_DIR, profile["directory"]), exist_ok=True)
    except Exception as e:
        print("Profil dosyası okunamadı:", e)
        profiles = default_profiles()

def get_profile(profile_id: str):
    profile = next((item for item in profiles if item["id"] == profile_id), None)
    if not profile:
        raise HTTPException(status_code=404, detail="Profil bulunamadı.")
    return profile

def get_profile_directory(profile_id: str):
    profile = get_profile(profile_id)
    directory = os.path.abspath(os.path.join(WORKSPACE_DIR, profile["directory"]))
    if os.path.commonpath([WORKSPACE_DIR, directory]) != os.path.abspath(WORKSPACE_DIR):
        raise HTTPException(status_code=400, detail="Geçersiz profil klasörü.")
    os.makedirs(directory, exist_ok=True)
    return directory

def profile_id_from_name(name: str):
    ascii_name = name.replace("ı", "i").replace("İ", "I")
    ascii_name = unicodedata.normalize("NFKD", ascii_name).encode("ascii", "ignore").decode("ascii")
    normalized = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return normalized

def get_status_filepath(order_id: str) -> str:
    """Sipariş ID'sinden (ör: naturan|siparisler_2026-06-30.xlsx|ID) ilgili JSON dosya yolunu üretir."""
    parts = order_id.split("|")
    if len(parts) >= 2:
        profile = parts[0]
        filename = parts[1]
        base_name = os.path.splitext(filename)[0]
        # Windows dosya ismi kısıtlamaları için geçersiz karakterleri temizle
        safe_base_name = re.sub(r'[<>:"/\\|?*]', '_', base_name)
        json_filename = f"{profile}__{safe_base_name}.json"
    else:
        json_filename = "general_status.json"
    return os.path.join(STATUS_DIR, json_filename)

def load_statuses():
    global sending_status
    sending_status = {}

    # 1. status_data klasöründeki tüm parçalı JSON dosyalarını oku
    if os.path.exists(STATUS_DIR):
        for fname in os.listdir(STATUS_DIR):
            if fname.endswith(".json"):
                fpath = os.path.join(STATUS_DIR, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        if isinstance(data, dict):
                            sending_status.update(data)
                except Exception as e:
                    print(f"Status dosyası okunamadı ({fname}):", e)

    # 2. Migration: Eski tekil sending_status.json varsa içeriğini ayrıştırıp parçalı dosyalara kaydet
    if os.path.exists(STATUS_FILE):
        try:
            with open(STATUS_FILE, "r", encoding="utf-8") as f:
                old_data = json.load(f)
                if isinstance(old_data, dict) and old_data:
                    print(f"[Migration] Eski STATUS_FILE ({len(old_data)} kayıt) parçalı dosyalara aktarılıyor...")
                    for oid, status_val in old_data.items():
                        sending_status[oid] = status_val
                    save_all_statuses()
            bak_path = STATUS_FILE + ".bak"
            if os.path.exists(bak_path):
                os.remove(bak_path)
            os.rename(STATUS_FILE, bak_path)
            print(f"[Migration] Eski STATUS_FILE {bak_path} olarak yedeklendi.")
        except Exception as e:
            print("Eski status dosyası migrate edilemedi:", e)

def save_all_statuses():
    """RAM'deki tüm durumları ilgili parçalı JSON dosyalarına ayırarak kaydeder."""
    grouped = {}
    for oid, val in sending_status.items():
        fpath = get_status_filepath(oid)
        if fpath not in grouped:
            grouped[fpath] = {}
        grouped[fpath][oid] = val

    for fpath, data in grouped.items():
        try:
            with open(fpath, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2, default=str)
        except Exception as e:
            print(f"Status dosyası kaydedilemedi ({fpath}):", e)

def save_statuses(order_ids=None):
    """
    Belirli bir veya birden fazla order_id verilirse sadece ilgili JSON dosya(lar)ını günceller.
    order_ids None verilirse tüm dosyaları günceller.
    """
    if order_ids is None:
        save_all_statuses()
        return

    if isinstance(order_ids, str):
        target_ids = [order_ids]
    else:
        target_ids = list(order_ids)

    target_filepaths = {get_status_filepath(oid) for oid in target_ids}

    for fpath in target_filepaths:
        file_statuses = {
            oid: val for oid, val in sending_status.items()
            if get_status_filepath(oid) == fpath
        }
        try:
            with open(fpath, "w", encoding="utf-8") as f:
                json.dump(file_statuses, f, ensure_ascii=False, indent=2, default=str)
        except Exception as e:
            print(f"Status dosyası kaydedilemedi ({fpath}):", e)

# Load statuses on startup
load_statuses()
load_profiles()

class MessageRequest(BaseModel):
    id: str
    phone: str
    message: str
    profile: str
    order: dict = None

class SetStatusRequest(BaseModel):
    id: str
    status: str
    profile: str
    error: str = ""
    order: dict = None

class HideRequest(BaseModel):
    id: str
    profile: str
    order: dict = None

class RestoreAllRequest(BaseModel):
    file: str = "all"
    profile: str

class ProfileCreateRequest(BaseModel):
    name: str

def format_phone_number(phone: str) -> str:
    # Remove whitespace and common characters
    phone_clean = "".join(c for c in str(phone) if c.isdigit() or c == '+')
    if phone_clean.startswith("+"):
        return phone_clean
    if phone_clean.startswith("0"):
        phone_clean = phone_clean[1:]
    if phone_clean.startswith("90") and len(phone_clean) > 10:
        return "+" + phone_clean
    return "+90" + phone_clean

def ensure_order_data(order_id: str, provided_order: dict = None):
    """Sipariş durum kaydında order_data bulunmasını her zaman otomatik olarak garanti eder."""
    if order_id not in sending_status:
        sending_status[order_id] = {}
        
    if provided_order:
        sending_status[order_id]["order_data"] = provided_order
        return

    if "order_data" not in sending_status[order_id]:
        try:
            parts = order_id.split("|")
            if len(parts) >= 3:
                profile_id, file_name, unique_id = parts[0], parts[1], parts[2]
                profile_dir = get_profile_directory(profile_id)
                file_path = os.path.join(profile_dir, file_name)
                if os.path.exists(file_path):
                    df = pd.read_excel(file_path)
                    df = df.fillna("")
                    match = df.iloc[0:0]
                    if 'ID' in df.columns:
                        match = df[df['ID'].astype(str) == str(unique_id)]
                    if match.empty:
                        id_col = 'Sipariş No' if 'Sipariş No' in df.columns else ('Sipari No' if 'Sipari No' in df.columns else None)
                        if id_col:
                            match = df[df[id_col].astype(str) == str(unique_id)]
                    if not match.empty:
                        rec = match.to_dict(orient="records")[0]
                        rec["Kaynak Dosya"] = file_name
                        rec["ID"] = order_id
                        for k, v in rec.items():
                            if hasattr(v, "strftime"):
                                rec[k] = v.strftime('%Y-%m-%d %H:%M:%S')
                            elif pd.isna(v):
                                rec[k] = ""
                        sending_status[order_id]["order_data"] = rec
        except Exception as e:
            print("ensure_order_data hatası:", e)

def run_sending_task(order_id: str, phone: str, message: str):
    with send_lock:
        with status_lock:
            ensure_order_data(order_id)
            sending_status[order_id]["status"] = "sending"
            sending_status[order_id]["error"] = ""
            save_statuses(order_id)

        try:
            print(f"[WA] Baileys ile gonderiliyor → {phone} (Sipariş: {order_id})")
            resp = httpx.post(
                f"{WHATSAPP_SERVICE_URL}/send",
                json={"phone": phone, "message": message},
                timeout=30.0
            )
            data = resp.json()

            if resp.status_code == 200 and data.get("success"):
                with status_lock:
                    if order_id not in sending_status:
                        sending_status[order_id] = {}
                    sending_status[order_id]["status"] = "sent"
                    sending_status[order_id]["error"] = ""
                    save_statuses(order_id)
                print(f"[WA] Gonderildi {phone}")
            else:
                error_msg = data.get("error", "Bilinmeyen hata")
                with status_lock:
                    if order_id not in sending_status:
                        sending_status[order_id] = {}
                    sending_status[order_id]["status"] = "failed"
                    sending_status[order_id]["error"] = error_msg
                    save_statuses(order_id)
                print(f"[WA] Gonderim basarisiz ({phone}): {error_msg}")

        except httpx.ConnectError:
            error_msg = "WhatsApp servisi bagli degil (localhost:3001 kapali)"
            with status_lock:
                if order_id not in sending_status:
                    sending_status[order_id] = {}
                sending_status[order_id]["status"] = "failed"
                sending_status[order_id]["error"] = error_msg
                save_statuses(order_id)
            print(f"[WA] Servis baglanti hatasi: {error_msg}")
        except Exception as e:
            error_msg = str(e)
            print(f"[WA] Hata ({phone}): {error_msg}")
            with status_lock:
                if order_id not in sending_status:
                    sending_status[order_id] = {}
                sending_status[order_id]["status"] = "failed"
                sending_status[order_id]["error"] = error_msg
                save_statuses(order_id)


@app.get("/api/health")
@app.get("/health")
@app.get("/api/ping")
def health_check():
    import time
    return {"ok": True, "status": "ok", "timestamp": int(time.time() * 1000)}

def start_self_ping():
    app_url = os.environ.get("RENDER_EXTERNAL_URL") or os.environ.get("APP_URL")
    if not app_url:
        print("[Self-Ping] RENDER_EXTERNAL_URL / APP_URL bulunamadı (yerel modda).")
        return

    health_url = app_url.rstrip("/") + "/api/health"
    print(f"[Self-Ping] Render uyanık tutma zamanlayıcısı başlatıldı (2 dakikada bir) → {health_url}")

    def ping_loop():
        import time
        while True:
            time.sleep(120)
            try:
                resp = httpx.get(health_url, timeout=10.0)
                if resp.status_code == 200:
                    print(f"✓ [Self-Ping] Başarılı ({resp.status_code})")
                else:
                    print(f"⚠️ [Self-Ping] Yanıt: {resp.status_code}")
            except Exception as e:
                print(f"⚠️ [Self-Ping] Bağlantı denemesi: {e}")

    threading.Thread(target=ping_loop, daemon=True).start()

@app.get("/")
def read_root():
    index_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path, headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        })
    return {"message": "Server is running, but index.html is missing."}

@app.get("/script.js")
def serve_script():
    path = os.path.join(PUBLIC_DIR, "script.js")
    return FileResponse(path, headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
    })

@app.get("/styles.css")
def serve_styles():
    path = os.path.join(PUBLIC_DIR, "styles.css")
    return FileResponse(path, headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
    })

@app.get("/api/profiles")
def get_profiles():
    with profiles_lock:
        return JSONResponse(content={"profiles": profiles})

@app.post("/api/profiles")
def create_profile(req: ProfileCreateRequest):
    name = req.name.strip()
    profile_id = profile_id_from_name(name)
    if not name or not profile_id:
        raise HTTPException(status_code=400, detail="Geçerli bir profil adı girin.")

    with profiles_lock:
        if any(profile["id"] == profile_id for profile in profiles):
            raise HTTPException(status_code=409, detail="Bu isimde bir profil zaten var.")
        profile = {"id": profile_id, "name": name, "directory": profile_id}
        profiles.append(profile)
        os.makedirs(get_profile_directory(profile_id), exist_ok=True)
        save_profiles()
    return JSONResponse(content={"profile": profile}, status_code=201)

@app.delete("/api/profiles/{profile_id}")
def delete_profile(profile_id: str):
    with profiles_lock:
        profile = get_profile(profile_id)
        profiles.remove(profile)
        save_profiles()
    return {"status": "deleted", "id": profile_id}

@app.get("/api/excel-files")
def get_excel_files(profile: str):
    try:
        profile_directory = get_profile_directory(profile)
        files = [f for f in os.listdir(profile_directory) if f.endswith(".xlsx") and not f.startswith("~$")]
        return JSONResponse(content={"files": sorted(files, reverse=True)})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Klasör listelenemedi: {str(e)}")

@app.post("/api/upload-excel")
async def upload_excel(
    profile: str = Form(...),
    files: Optional[List[UploadFile]] = File(None),
    file: Optional[UploadFile] = File(None)
):
    get_profile(profile)
    
    file_list = []
    if files:
        file_list.extend(files)
    if file:
        file_list.append(file)
        
    if not file_list:
        raise HTTPException(status_code=400, detail="Hiçbir dosya yüklenmedi.")

    uploaded = []
    errors = []
    profile_dir = get_profile_directory(profile)

    for item in file_list:
        if not item.filename:
            continue
        if not item.filename.lower().endswith(".xlsx"):
            errors.append(f"{item.filename}: Sadece .xlsx uzantılı Excel dosyaları yüklenebilir.")
            continue
        safe_filename = os.path.basename(item.filename)
        target_path = os.path.join(profile_dir, safe_filename)
        try:
            content = await item.read()
            with open(target_path, "wb") as f:
                f.write(content)
            uploaded.append(safe_filename)
        except Exception as e:
            errors.append(f"{safe_filename}: {str(e)}")

    if not uploaded and errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))

    message = f"{len(uploaded)} dosya başarıyla yüklendi." if len(uploaded) > 1 else (f"{uploaded[0]} başarıyla yüklendi." if uploaded else "")
    return {
        "status": "success",
        "uploaded": uploaded,
        "errors": errors,
        "message": message
    }

@app.delete("/api/excel-files/{filename}")
def delete_excel_file(filename: str, profile: str):
    get_profile(profile)
    if "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Geçersiz dosya adı.")
    
    profile_dir = get_profile_directory(profile)
    target_path = os.path.join(profile_dir, filename)

    if not os.path.exists(target_path):
        raise HTTPException(status_code=404, detail="Excel dosyası bulunamadı.")
    
    try:
        os.remove(target_path)
        return {"status": "deleted", "filename": filename, "message": f"{filename} silindi."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Dosya silinemedi: {str(e)}")

def clean_record_dates(df):
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].dt.strftime('%Y-%m-%d %H:%M:%S')
    df = df.fillna("")
    records = df.to_dict(orient="records")
    clean_records = []
    for r in records:
        cr = {}
        for k, v in r.items():
            if pd.isna(v):
                cr[k] = ""
            elif hasattr(v, "strftime"):
                cr[k] = v.strftime('%Y-%m-%d %H:%M:%S')
            else:
                cr[k] = v
        clean_records.append(cr)
    return clean_records

@app.get("/api/orders")
def get_orders(profile: str, file: str = "all"):
    profile_directory = get_profile_directory(profile)

    # If file is "all", combine all xlsx files
    if file == "all":
        try:
            files = [f for f in os.listdir(profile_directory) if f.endswith(".xlsx") and not f.startswith("~$")]
            if not files:
                return JSONResponse(content={"orders": [], "file": "all"})

            all_records = []
            for f in sorted(files, reverse=True):
                file_path = os.path.join(profile_directory, f)
                try:
                    df = pd.read_excel(file_path)
                    df["Kaynak Dosya"] = f
                    file_records = clean_record_dates(df)
                    for r in file_records:
                        if 'ID' not in r or not r['ID']:
                            r['ID'] = str(r.get('Sipariş No', r.get('Sipari No', '')))
                        r['ID'] = f"{profile}|{f}|{str(r['ID'])}"
                        all_records.append(r)
                except Exception as ex:
                    print(f"Excel okunurken atlandı ({f}):", ex)

            return JSONResponse(content={"orders": all_records, "file": "all"})
        except HTTPException:
            raise
        except Exception as e:
            print("Toplu Excel okuma hatası:", e)
            raise HTTPException(status_code=500, detail=f"Toplu Excel okuma hatası: {str(e)}")

    # For single files
    if "/" in file or "\\" in file:
        raise HTTPException(status_code=400, detail="Geçersiz dosya adı.")

    file_path = os.path.join(profile_directory, file)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail=f"Siparişler Excel dosyası bulunamadı: {file}")

    try:
        df = pd.read_excel(file_path)
        df["Kaynak Dosya"] = file
        records = clean_record_dates(df)

        for r in records:
            if 'ID' not in r or not r['ID']:
                r['ID'] = str(r.get('Sipariş No', r.get('Sipari No', '')))
            r['ID'] = f"{profile}|{file}|{str(r['ID'])}"

        return JSONResponse(content={"orders": records, "file": file})
    except Exception as e:
        print("Excel okuma hatası:", e)
        raise HTTPException(status_code=500, detail=f"Excel okuma hatası: {str(e)}")

@app.post("/api/send")
def send_message(req: MessageRequest, background_tasks: BackgroundTasks):
    get_profile(req.profile)
    with status_lock:
        ensure_order_data(req.id, req.order)
        sending_status[req.id]["status"] = "queued"
        sending_status[req.id]["error"] = ""
        save_statuses(req.id)

    # Run the sending task in background so we return immediately
    background_tasks.add_task(run_sending_task, req.id, req.phone, req.message)
    return {"status": "queued", "id": req.id}

@app.get("/api/whatsapp-status")
def get_whatsapp_status():
    """WhatsApp Baileys servisinin bağlantı durumunu döner."""
    try:
        resp = httpx.get(f"{WHATSAPP_SERVICE_URL}/status", timeout=3.0)
        return JSONResponse(content=resp.json())
    except Exception:
        return JSONResponse(content={"state": "service_offline"})

@app.get("/api/whatsapp-qr")
def get_whatsapp_qr():
    """QR kod base64 data URL'ini döner (bağlı değilse)."""
    try:
        resp = httpx.get(f"{WHATSAPP_SERVICE_URL}/qr", timeout=3.0)
        return JSONResponse(content=resp.json())
    except Exception:
        return JSONResponse(content={"qr": None, "state": "service_offline"})

@app.post("/api/whatsapp-connect")
def whatsapp_connect():
    """WhatsApp bağlantısını başlat (QR üret veya bağlan)."""
    try:
        resp = httpx.post(f"{WHATSAPP_SERVICE_URL}/connect", timeout=5.0)
        return JSONResponse(content=resp.json())
    except Exception:
        return JSONResponse(content={"success": False, "error": "Servis çevrimdışı"})

@app.post("/api/whatsapp-cancel")
def whatsapp_cancel():
    """Bağlantı sürecini iptal et (bağlanılmadıysa socket'i kapat)."""
    try:
        resp = httpx.post(f"{WHATSAPP_SERVICE_URL}/cancel", timeout=5.0)
        return JSONResponse(content=resp.json())
    except Exception:
        return JSONResponse(content={"success": False, "error": "Servis çevrimdışı"})

@app.post("/api/whatsapp-logout")
def whatsapp_logout():
    """WhatsApp oturumunu kapat."""
    try:
        resp = httpx.post(f"{WHATSAPP_SERVICE_URL}/logout", timeout=5.0)
        return JSONResponse(content=resp.json())
    except Exception:
        return JSONResponse(content={"success": False, "error": "Servis çevrimdışı"})

@app.get("/api/status")
def get_status(profile: str):
    get_profile(profile)
    with status_lock:
        profile_prefix = f"{profile}|"
        return JSONResponse(content={
            order_id: status for order_id, status in sending_status.items()
            if order_id.startswith(profile_prefix)
        })

@app.post("/api/mark-sent")
def mark_sent(req: MessageRequest):
    """Manually mark an order as sent (used by the WhatsApp Web button)."""
    get_profile(req.profile)
    with status_lock:
        ensure_order_data(req.id, req.order)
        sending_status[req.id]["status"] = "sent"
        sending_status[req.id]["error"] = ""
        save_statuses(req.id)
    return {"status": "sent", "id": req.id}

@app.post("/api/set-order-status")
def set_order_status(req: SetStatusRequest):
    get_profile(req.profile)
    with status_lock:
        if req.status == "pending" and not sending_status.get(req.id, {}).get("hidden"):
            if req.id in sending_status:
                del sending_status[req.id]
        else:
            ensure_order_data(req.id, req.order)
            sending_status[req.id]["status"] = req.status
            sending_status[req.id]["error"] = req.error
        save_statuses(req.id)
    return {"status": req.status, "id": req.id}

@app.post("/api/hide-order")
def hide_order(req: HideRequest):
    from datetime import datetime, timezone
    get_profile(req.profile)
    with status_lock:
        ensure_order_data(req.id, req.order)
        sending_status[req.id]["hidden"] = True
        sending_status[req.id]["hidden_at"] = datetime.now(timezone.utc).isoformat()
        save_statuses(req.id)
    return {"status": "hidden", "id": req.id}

@app.post("/api/restore-order")
def restore_order(req: HideRequest):
    get_profile(req.profile)
    with status_lock:
        if req.id in sending_status:
            sending_status[req.id]["hidden"] = False
            ensure_order_data(req.id, req.order)
            save_statuses(req.id)
    return {"status": "restored", "id": req.id}

@app.post("/api/restore-all-orders")
def restore_all_orders(req: RestoreAllRequest):
    file = req.file
    get_profile(req.profile)
    with status_lock:
        for oid in list(sending_status.keys()):
            if not oid.startswith(f"{req.profile}|"):
                continue
            if sending_status[oid].get("hidden"):
                if file != "all" and not oid.startswith(f"{req.profile}|{file}|"):
                    continue
                sending_status[oid]["hidden"] = False
                ensure_order_data(oid)
        save_statuses()
    return {"message": f"Hidden orders restored for file: {file}"}

PUBLIC_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PUBLIC_DIR)
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="static")

def open_browser():
    time.sleep(1.2)
    webbrowser.open("http://127.0.0.1:8000")

node_process = None

def kill_node_on_port(port: int):
    """Belirtilen portu kullanan node prosesini öldürür (EADDRINUSE önleme)."""
    try:
        if sys.platform == "win32":
            # Windows: PowerShell ile PID bul, taskkill ile öldür
            result = subprocess.run(
                ["powershell", "-Command",
                 f"Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | "
                 f"Select-Object -ExpandProperty OwningProcess"],
                capture_output=True, text=True, timeout=5
            )
            pids = set(result.stdout.strip().split())
            for pid_str in pids:
                try:
                    pid = int(pid_str)
                    if pid > 0:
                        subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                                       capture_output=True, timeout=3)
                        print(f"[Server] Port {port} üzerindeki PID {pid} sonlandırıldı.")
                except (ValueError, Exception):
                    pass
        else:
            # Mac / Linux: lsof ile PID bul, kill ile öldür
            result = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}"],
                capture_output=True, text=True, timeout=5
            )
            pids = set(result.stdout.strip().split())
            for pid_str in pids:
                try:
                    pid = int(pid_str)
                    if pid > 0:
                        subprocess.run(["kill", "-9", str(pid)],
                                       capture_output=True, timeout=3)
                        print(f"[Server] Port {port} üzerindeki PID {pid} sonlandırıldı.")
                except (ValueError, Exception):
                    pass
        time.sleep(1)
    except Exception as e:
        print(f"[Server] Port temizleme hatası: {e}")

def start_whatsapp_service():
    global node_process
    try:
        service_path = os.path.join(WORKSPACE_DIR, "whatsapp-service")
        index_js = os.path.join(service_path, "index.js")

        # Port 3001 doluysa önceki prosesi öldür
        kill_node_on_port(3001)

        print(f"[Server] Node.js WhatsApp servisi baslatiliyor: {index_js}")
        node_process = subprocess.Popen(
            ["node", "index.js"],
            cwd=service_path,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
        )
        
        def log_node_output():
            while True:
                line = node_process.stdout.readline()
                if not line:
                    break
                stripped = line.strip()
                # Sadece [WA] ile başlayan satırları göster — Baileys iç loglarını filtrele
                if stripped.startswith('[WA]'):
                    print(f"[Node] {stripped}")
        
        def log_node_error():
            while True:
                line = node_process.stderr.readline()
                if not line:
                    break
                stripped = line.strip()
                # Boş satırları ve gereksiz Baileys iç loglarını filtrele
                if stripped and not any(stripped.startswith(k) for k in [
                    'at ', '    at ', 'Object.', 'process.', 'node:',
                ]):
                    print(f"[Node Error] {stripped}", file=sys.stderr)

        threading.Thread(target=log_node_output, daemon=True).start()
        threading.Thread(target=log_node_error, daemon=True).start()
    except Exception as e:
        print(f"[Server Error] WhatsApp servisi baslatilamadi: {e}")

def kill_whatsapp_service():
    global node_process
    if node_process:
        print("[Server] Node.js WhatsApp servisi durduruluyor...")
        node_process.terminate()
        try:
            node_process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            node_process.kill()

atexit.register(kill_whatsapp_service)

if __name__ == "__main__":
    start_whatsapp_service()
    start_self_ping()
    if not os.environ.get("RENDER_EXTERNAL_URL") and not os.environ.get("PORT"):
        threading.Thread(target=open_browser, daemon=True).start()
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False, log_level="warning", access_log=False)
