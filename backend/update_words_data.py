import urllib.request
import json
from sqlalchemy.orm import Session
from app.database import engine, SessionLocal
from app import models
import time

def update_words_data():
    db = SessionLocal()
    try:
        # Get all surahs
        surahs = db.query(models.Surah).all()
        if not surahs:
            print("No Surahs found in database. Run the seeding script first.")
            return

        for surah in surahs:
            print(f"Fetching words data for Surah {surah.id}...")
            url = f"https://api.quran.com/api/v4/verses/by_chapter/{surah.id}?words=true&word_fields=code_v1,text_uthmani&audio=7&per_page=300"
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            try:
                with urllib.request.urlopen(req) as response:
                    data = json.loads(response.read().decode())
            except Exception as e:
                print(f"Failed to fetch Surah {surah.id}: {e}")
                continue
            
            verses = data.get("verses", [])
            
            for verse in verses:
                ayah_number = verse.get("verse_number")
                api_words = verse.get("words", [])
                audio_data = verse.get("audio", {})
                segments = audio_data.get("segments", [])
                
                segment_lookup = {}
                for seg in segments:
                    if len(seg) >= 4:
                        position = seg[0] + 1
                        segment_lookup[position] = {"start_ms": seg[2], "end_ms": seg[3]}

                final_words = []
                for w in api_words:
                    position = w.get("position")
                    if w.get("char_type_name") == "end":
                        continue
                        
                    word_data = {
                        "position": position,
                        "text": w.get("code_v1", w.get("text", "")),
                        "text_uthmani": w.get("text_uthmani", ""),
                        "translation": w.get("translation", {}).get("text", "") if w.get("translation") else "",
                    }
                    
                    # Attach timestamps if available
                    if position in segment_lookup:
                        word_data["start_ms"] = segment_lookup[position]["start_ms"]
                        word_data["end_ms"] = segment_lookup[position]["end_ms"]
                        
                    final_words.append(word_data)
                
                # Update the database record
                db_ayah = db.query(models.Ayah).filter(
                    models.Ayah.surah_id == surah.id,
                    models.Ayah.ayah_number == ayah_number
                ).first()
                
                if db_ayah:
                    db_ayah.words = final_words
            
            db.commit()
            print(f"Updated Surah {surah.id} successfully.")
            # Sleep to avoid rate limiting
            time.sleep(1)
            
    finally:
        db.close()

if __name__ == "__main__":
    print("Starting word-by-word data update...")
    # Make sure tables are created (especially the new words column)
    # Note: We added the column to models.py, but SQLite/Postgres might need an ALTER TABLE
    # If using SQLAlchemy's create_all, it doesn't automatically add new columns.
    # To fix this, we can try to add the column manually if it fails.
    try:
        update_words_data()
    except Exception as e:
        print(f"Error occurred: {e}")
        print("You may need to run alembic migration or manually alter the table to add the 'words' column: ALTER TABLE ayahs ADD COLUMN words JSON;")
