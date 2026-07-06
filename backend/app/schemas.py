from pydantic import BaseModel
from typing import List, Optional, Any

class AyahBase(BaseModel):
    ayah_number: int
    text_arabic: str
    text_turkish: str
    audio_url: str
    juz_number: int
    page_number: Optional[int] = None
    sajdah: bool
    words: Optional[Any] = None

class Ayah(AyahBase):
    id: int
    surah_id: int

    class Config:
        from_attributes = True

class SurahBase(BaseModel):
    name_arabic: str
    name_turkish: str
    name_transliteration: str
    type: str
    total_ayahs: int

class Surah(SurahBase):
    id: int

    class Config:
        from_attributes = True

class SurahWithAyahs(Surah):
    ayahs: List[Ayah] = []

    class Config:
        from_attributes = True
