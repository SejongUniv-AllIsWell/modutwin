FROM python:3.11-slim

WORKDIR /app
ENV PYTHONPATH=/app

# ffmpeg + OpenCV 의존 시스템 라이브러리, + Node.js 설치용 도구
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgl1 \
    curl \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 (SOG 변환기 splat-transform 실행/빌드용)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# SOG 변환기 빌드 (CPU 전용; webgpu 는 optional 이라 미설치여도 무방).
# 빌드에 필요한 devDependencies 설치 → 번들 → dev 의존성 정리로 이미지 축소.
RUN cd /app/splat-transform \
    && npm ci --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

CMD ["celery", "-A", "celery_app", "worker", "-Q", "training,alignment", "-c", "1", "--loglevel=info"]
