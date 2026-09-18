from sqlalchemy.orm import Session
from app.database import engine, SessionLocal, Base
from app import models

def init_db():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    # Check if we already have surahs
    if db.query(models.Surah).count() == 0:
        print("Seeding database with dummy data...")
        # Create a dummy Surah
        surah_fatiha = models.Surah(
            name_arabic="الفاتحة",
            name_turkish="Fâtiha",
            name_transliteration="Al-Fatihah",
            type="Meccan",
            total_ayahs=7
        )
        db.add(surah_fatiha)
        db.commit()
        db.refresh(surah_fatiha)

        # Create dummy Ayahs
        ayahs = [
            models.Ayah(surah_id=surah_fatiha.id, ayah_number=1, text_arabic="بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ", text_turkish="Rahmân ve Rahîm olan Allah'ın adıyla.", audio_url="static/audio/1_1.mp3"),
            models.Ayah(surah_id=surah_fatiha.id, ayah_number=2, text_arabic="الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ", text_turkish="Hamd, âlemlerin Rabbi Allah'a mahsustur.", audio_url="static/audio/1_2.mp3"),
            # Add more as needed...
        ]
        db.bulk_save_objects(ayahs)
        db.commit()
        print("Database seeded successfully.")
    else:
        print("Database already seeded.")

    db.close()

if __name__ == "__main__":
    init_db()
