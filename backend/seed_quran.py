import json
import os
import urllib.request
from sqlalchemy.orm import Session
from app.database import SessionLocal, engine, Base
from app import models

# Turkish Surah names based on quranData.ts
SURAH_TURKISH_NAMES = {
    1: "Fâtiha", 2: "Bakara", 3: "Âl-i İmrân", 4: "Nisâ", 5: "Mâide",
    6: "En'âm", 7: "A'râf", 8: "Enfâl", 9: "Tevbe", 10: "Yûnus",
    11: "Hûd", 12: "Yûsuf", 13: "Ra'd", 14: "İbrâhim", 15: "Hicr",
    16: "Nahl", 17: "İsrâ", 18: "Kehf", 19: "Meryem", 20: "Tâhâ",
    21: "Enbiyâ", 22: "Hac", 23: "Mü'minûn", 24: "Nûr", 25: "Furkân",
    26: "Şuarâ", 27: "Neml", 28: "Kasas", 29: "Ankebût", 30: "Rûm",
    31: "Lokmân", 32: "Secde", 33: "Ahzâb", 34: "Sebe'", 35: "Fâtır",
    36: "Yâsîn", 37: "Sâffât", 38: "Sâd", 39: "Zümer", 40: "Mü'min",
    41: "Fussilet", 42: "Şûrâ", 43: "Zuhruf", 44: "Duhân", 45: "Câsiye",
    46: "Ahkāf", 47: "Muhammed", 48: "Fetih", 49: "Hucurât", 50: "Kāf",
    51: "Zâriyât", 52: "Tûr", 53: "Necm", 54: "Kamer", 55: "Rahmân",
    56: "Vâkıa", 57: "Hadîd", 58: "Mücâdele", 59: "Haşr", 60: "Mümtehine",
    61: "Saf", 62: "Cum'a", 63: "Münâfikûn", 64: "Teğâbün", 65: "Talâk",
    66: "Tahrîm", 67: "Mülk", 68: "Kalem", 69: "Hâkka", 70: "Meâric",
    71: "Nûh", 72: "Cin", 73: "Müzzemmil", 74: "Müddessir", 75: "Kıyâmet",
    76: "İnsân", 77: "Mürselât", 78: "Nebe'", 79: "Nâziât", 80: "Abese",
    81: "Tekvîr", 82: "İnfitâr", 83: "Mutaffifîn", 84: "İnşikāk", 85: "Burûc",
    86: "Târık", 87: "A'lâ", 88: "Ğâşiye", 89: "Fecr", 90: "Beled",
    91: "Şems", 92: "Leyl", 93: "Duhâ", 94: "İnşirâh", 95: "Tîn",
    96: "Alak", 97: "Kadr", 98: "Beyyine", 99: "Zilzâl", 100: "Âdiyât",
    101: "Kâria", 102: "Tekâsür", 103: "Asr", 104: "Hümeze", 105: "Fîl",
    106: "Kureyş", 107: "Mâûn", 108: "Kevser", 109: "Kâfirûn", 110: "Nasr",
    111: "Mesed", 112: "İhlâs", 113: "Felak", 114: "Nâs",
}

def format_number(num):
    return str(num).zfill(3)

def seed_db():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    
    if db.query(models.Surah).count() == 114:
        print("Database already seeded.")
        db.close()
        return

    print("Clearing old data (if any)...")
    db.query(models.Ayah).delete()
    db.query(models.Surah).delete()
    db.commit()

    print("Fetching Surahs metadata from API...")
    req = urllib.request.Request("https://api.alquran.cloud/v1/surah", headers={'User-Agent': 'Mozilla/5.0'})
    surahs_res = json.loads(urllib.request.urlopen(req).read().decode('utf-8'))["data"]
    
    print("Fetching Turkish translations from API...")
    req = urllib.request.Request("https://api.alquran.cloud/v1/quran/tr.yazir", headers={'User-Agent': 'Mozilla/5.0'})
    tr_res = json.loads(urllib.request.urlopen(req).read().decode('utf-8'))["data"]["surahs"]
    
    print("Loading local Quran data (PUA text + page numbers)...")
    quran_file = os.path.join(os.path.dirname(__file__), "data", "quran.json")
    with open(quran_file, "r", encoding="utf-8") as f:
        quran_data = json.load(f)

    pua_lookup = {}
    for surah in quran_data:
        surah_id = surah["id"]
        for verse in surah["verses"]:
            pua_lookup[(surah_id, verse["id"])] = verse

    print("Seeding Surahs and Ayahs...")
    for s in surahs_res:
        surah_id = s["number"]
        surah = models.Surah(
            id=surah_id,
            name_arabic=s["name"],
            name_turkish=SURAH_TURKISH_NAMES.get(surah_id, s["englishName"]),
            name_transliteration=s["englishName"],
            type=s["revelationType"],
            total_ayahs=s["numberOfAyahs"]
        )
        db.add(surah)
        db.commit() # Commit each surah so Ayahs can ref it

        ayahs_list = []
        tr_ayahs = tr_res[surah_id - 1]["ayahs"]
        
        for tr_a in tr_ayahs:
            aya_num = tr_a["numberInSurah"]
            pua = pua_lookup.get((surah_id, aya_num))
            
            # Using everyayah.com format as fallback or standard format used in UI
            audio_url = f"https://everyayah.com/data/Alafasy_128kbps/{format_number(surah_id)}{format_number(aya_num)}.mp3"
            
            sajdah = False
            if isinstance(tr_a.get("sajda"), dict):
                sajdah = True
            elif tr_a.get("sajda") is True:
                sajdah = True
                
            ayah = models.Ayah(
                surah_id=surah_id,
                ayah_number=aya_num,
                text_arabic=pua["text"] if pua else tr_a["text"],
                text_turkish=tr_a["text"],
                audio_url=audio_url,
                juz_number=tr_a["juz"],
                page_number=pua["page"] if pua else tr_a.get("page", 1),
                sajdah=sajdah
            )
            ayahs_list.append(ayah)
        
        db.bulk_save_objects(ayahs_list)
        db.commit()
        print(f"Seeded Surah {surah_id} ({surah.name_transliteration}) with {len(ayahs_list)} Ayahs.")

    print("Database seeded successfully!")
    db.close()

if __name__ == "__main__":
    seed_db()
