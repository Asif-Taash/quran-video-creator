from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import g4f
from g4f.client import Client

router = APIRouter()

class ChatRequest(BaseModel):
    system_prompt: str
    user_message: str

@router.post("/chat")
def chat_completion(request: ChatRequest):
    try:
        client = Client()
        response = client.chat.completions.create(
            model="gpt-4o", # g4f will automatically route to a free provider supporting this
            messages=[
                {"role": "system", "content": request.system_prompt},
                {"role": "user", "content": request.user_message}
            ],
            # To ensure it doesn't hang forever, set a timeout or max retries if possible
        )
        
        return {"result": response.choices[0].message.content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
