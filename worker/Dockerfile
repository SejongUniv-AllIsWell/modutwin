FROM python:3.11-slim

WORKDIR /app
ENV PYTHONPATH=/app

# ffmpeg + OpenCV 의존 시스템 라이브러리
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["celery", "-A", "celery_app", "worker", "-Q", "training,alignment", "-c", "1", "--loglevel=info"]
