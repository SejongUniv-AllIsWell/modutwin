# miniforge 베이스: COLMAP/pycolmap 을 conda-forge(aarch64·x86_64 prebuilt)로 설치.
# pip 휠이 없는 arm64(DGX Spark)에서도 소스 컴파일 없이 동작한다.
FROM condaforge/miniforge3:latest

WORKDIR /app
ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1

# ffmpeg + OpenCV/GL 런타임 라이브러리 + Node.js 설치 도구
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgl1 \
    curl \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# COLMAP CLI + pycolmap (conda-forge). colmap_module.py 는 `colmap` 바이너리를,
# core/door_alignment/* 는 pycolmap 파이썬 API 를 사용한다. 둘 다 여기서 해결.
# 참고: conda-forge 의 aarch64 colmap 은 CPU 빌드일 수 있다(기능은 동일, SfM 속도만 차이).
RUN mamba install -y -n base -c conda-forge colmap pycolmap \
    && mamba clean -afy

# Node.js 20 (SOG 변환기 splat-transform 빌드/실행용)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 나머지 파이썬 의존성 (pycolmap 은 conda 로 설치되므로 requirements 에서 제외)
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
