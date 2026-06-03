# RTX x86_64 NVIDIA GPU worker.
#
# This image is intentionally separate from worker_dgx/Dockerfile:
# - worker_dgx/ stays DGX Spark/arm64-friendly and mounts the host gsplat env.
# - worker_rtx/ installs CUDA/PyTorch/gsplat inside the container and uses
#   standard NVIDIA Container Toolkit GPU passthrough.
FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04

WORKDIR /app
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TORCH_CUDA_ARCH_LIST="8.6 8.9 12.0+PTX" \
    GSPLAT_REPO=/opt/gsplat \
    GSPLAT_PYTHON=/usr/bin/python3 \
    GSPLAT_TRAINER=/opt/gsplat/examples/simple_trainer.py

# ffmpeg + COLMAP + Python build/runtime libraries + Node.js install tools.
# libvulkan1: Vulkan loader for splat-transform WebGPU/Dawn on NVIDIA GPUs.
#   NVIDIA Vulkan ICD/driver libraries are mounted by NVIDIA Container Toolkit at runtime
#   (compose must expose the graphics driver capability). vulkan-tools is for vulkaninfo checks.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ffmpeg \
    git \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    python-is-python3 \
    colmap \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgl1 \
    libgomp1 \
    libvulkan1 \
    vulkan-tools \
    curl \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 (SOG 변환기 splat-transform 빌드/실행용)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

ARG PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
ARG GSPLAT_REF=main

# PyTorch CUDA wheel first, then app deps. gsplat examples/simple_trainer.py is
# installed from source because the worker calls that script directly.
COPY requirements.txt .
RUN python3 -m pip install --no-cache-dir --ignore-installed "setuptools<81" wheel \
    && python3 -m pip install --no-cache-dir torch torchvision --index-url "${PYTORCH_INDEX_URL}" \
    && python3 -m pip install --no-cache-dir -r requirements.txt \
    && git clone https://github.com/nerfstudio-project/gsplat.git "${GSPLAT_REPO}" \
    && cd "${GSPLAT_REPO}" \
    && git fetch --depth=1 origin "${GSPLAT_REF}" \
    && git checkout FETCH_HEAD \
    && git submodule update --init --recursive \
    && python3 -m pip install --no-cache-dir ninja numpy jaxtyping rich \
    && python3 -m pip install --no-cache-dir --no-build-isolation -e "${GSPLAT_REPO}" \
    && python3 -m pip install --no-cache-dir --no-build-isolation -r "${GSPLAT_REPO}/examples/requirements.txt"

COPY . .

# SOG 변환기 빌드. webgpu(Dawn) 는 optionalDependency + rollup external 이라 런타임에
# `import 'webgpu'` 로 로드된다. `npm prune --omit=dev` 는 optional 을 유지하므로 GPU(Vulkan)
# 경로가 살아있다. (★ `--omit=optional` 로 빌드하면 webgpu 가 빠져 GPU 시도가 죽고 CPU 폴백만
# 남으니 금지.) Vulkan 미가용 시엔 CPU(-g cpu)로 동작한다(tasks/sog.py 가 자동 폴백).
# 빌드에 필요한 devDependencies 설치 → 번들 → dev 의존성 정리로 이미지 축소.
RUN cd /app/splat-transform \
    && npm ci --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

CMD ["celery", "-A", "celery_app", "worker", "-Q", "training,alignment", "-c", "1", "--loglevel=info"]
