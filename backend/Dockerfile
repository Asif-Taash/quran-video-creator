FROM python:3.10-slim-bookworm

WORKDIR /app

# Install system dependencies directly from official live repositories
RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq-dev gcc python3-dev libespeak-dev espeak-ng-espeak ffmpeg && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir numpy==1.26.4
# CUDA build of torch/torchaudio in its own layer (~3GB), so editing
# requirements.txt doesn't re-download it. The MMS_FA forced aligner in
# scripts/quran_aligner.py runs ~50x faster on the GPU than on the CPU.
# PyPI stays available for plain dependencies (the PyTorch index only has an
# sdist of typing-extensions, whose build backend it doesn't host); pip still
# picks torch from the CUDA index since "2.11.0+cu126" outranks "2.11.0".
# The BuildKit cache mount keeps already-downloaded wheels across build
# attempts (not in the image), so a dropped connection mid-download resumes
# instead of starting the whole ~3GB over.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --default-timeout=120 --retries 10 torch==2.11.0 torchaudio==2.11.0 \
    --index-url https://download.pytorch.org/whl/cu126 --extra-index-url https://pypi.org/simple

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Ensure ctranslate2 can find the pip-installed CUDA libraries for GPU acceleration
ENV LD_LIBRARY_PATH="/usr/local/lib/python3.10/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.10/site-packages/nvidia/cudnn/lib:${LD_LIBRARY_PATH}"

# Expose port
EXPOSE 8000

# Command to run the application with hot-reload enabled
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]