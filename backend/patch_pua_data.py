import json
import os
import sqlite3
import sys
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.database import SQLALCHEMY_DATABASE_URL
from app.models import Ayah

def main():
    json_path = os.path.join(os.path.dirname(__file__), "data", "quran.json")
    if not os.path.exists(json_path):
        print(f"Error: {json_path} not found.")
        sys.exit(1)

    print(f"Loading Quran data from {json_path}...")
    with open(json_path, "r", encoding="utf-8") as f:
        quran_data = json.load(f)

    # Create a map of (surah_id, aya) -> verse
    pua_map = {}
    for surah in quran_data:
        surah_id = surah["id"]
        for verse in surah["verses"]:
            pua_map[(surah_id, verse["id"])] = verse

    from sqlalchemy import create_engine, text

    print("Connecting to database...")
    engine = create_engine(SQLALCHEMY_DATABASE_URL)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db = SessionLocal()

    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE ayahs ADD COLUMN IF NOT EXISTS page_number INTEGER;"))
            print("Ensured page_number column exists in ayahs table.")
    except Exception as e:
        print("Warning while altering table:", e)

    print("Updating ayahs...")
    ayahs = db.query(Ayah).all()
    updated = 0
    for ayah in ayahs:
        # PUA json uses sura and aya index
        key = (ayah.surah_id, ayah.ayah_number)
        if key in pua_map:
            pua_info = pua_map[key]
            ayah.text_arabic = pua_info["text"]
            ayah.page_number = pua_info.get("page")
            updated += 1
        else:
            print(f"Warning: No PUA data found for Surah {ayah.surah_id} Ayah {ayah.ayah_number}")
    
    db.commit()
    db.close()
    print(f"Successfully updated {updated} ayahs with PUA text and page numbers.")

if __name__ == "__main__":
    main()
