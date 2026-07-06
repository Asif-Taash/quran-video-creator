from sqlalchemy import Column, Integer, String, Text, ForeignKey, Boolean, JSON
from sqlalchemy.orm import relationship
from .database import Base

class Surah(Base):
    __tablename__ = "surahs"

    id = Column(Integer, primary_key=True, index=True)
    name_arabic = Column(String, index=True)
    name_turkish = Column(String)
    name_transliteration = Column(String)
    type = Column(String)
    total_ayahs = Column(Integer)

    ayahs = relationship("Ayah", back_populates="surah", order_by="Ayah.ayah_number")

class Ayah(Base):
    __tablename__ = "ayahs"

    id = Column(Integer, primary_key=True, index=True)
    surah_id = Column(Integer, ForeignKey("surahs.id"))
    ayah_number = Column(Integer)
    text_arabic = Column(Text)
    text_turkish = Column(Text)
    audio_url = Column(String)
    juz_number = Column(Integer)
    page_number = Column(Integer, nullable=True)
    sajdah = Column(Boolean, default=False)
    words = Column(JSON, nullable=True)

    surah = relationship("Surah", back_populates="ayahs")
