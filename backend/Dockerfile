FROM python:3.10-slim-bullseye

WORKDIR /app

# Install system dependencies for psycopg2 and aeneas
RUN apt-get update && apt-get install -y libpq-dev gcc python3-dev libespeak-dev espeak-ng-espeak ffmpeg

COPY requirements.txt .
RUN pip install --no-cache-dir numpy==1.26.4
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Ensure ctranslate2 can find the pip-installed CUDA libraries for GPU acceleration
ENV LD_LIBRARY_PATH="/usr/local/lib/python3.10/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.10/site-packages/nvidia/cudnn/lib:${LD_LIBRARY_PATH}"

# Expose port
EXPOSE 8000

# Command to run the application with hot-reload enabled
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
