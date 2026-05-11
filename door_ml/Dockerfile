# door-ml 서비스
#
# SAM3 공식 prerequisites (2025-05):
#   Python 3.12+, CUDA 12.6+, PyTorch 2.7+
#   Source: https://github.com/facebookresearch/sam3
#
# facebook/sam3 는 HuggingFace gated 모델이므로
# HF_TOKEN 환경변수가 반드시 필요하다 (.env 또는 compose env 주입).
# 체크포인트는 컨테이너 최초 기동 시 다운로드되고 이후 볼륨에 캐싱된다.
#
# CUDA 13 / PyTorch cu130 사용 이유: NVIDIA GB10 = compute capability 12.1 (sm_121)
# - cu126: sm_80/sm_90 까지 → cudaErrorNoKernelImageForDevice
# - cu128: sm_120 까지 (NVRTC 가 sm_121 거부 → reduction kernel JIT 실패)
# - cu130: sm_121 정식 지원
#
# devel 이미지 사용 이유: gsplat 은 nvcc 가 있어야 CUDA extension 을
# AOT/JIT 컴파일한다. runtime 이미지엔 nvcc 가 없어 'NoneType' has no
# attribute 'CameraModelType' 발생.

FROM nvidia/cuda:13.0.1-cudnn-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    TORCH_CUDA_ARCH_LIST="12.1+PTX"

# Ubuntu 24.04는 기본 Python 3.12 제공
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.12 python3.12-dev python3-pip \
        libgl1 libglib2.0-0 \
        git \
    && ln -sf python3.12 /usr/bin/python3 \
    && ln -sf python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# PyTorch + torchvision (CUDA 13.0 빌드 nightly — sm_121 NVRTC 지원)
# torchvision 도 같은 인덱스에서 받아야 torch 와 ABI 호환.
RUN pip install --no-cache-dir --pre torch torchvision --index-url https://download.pytorch.org/whl/nightly/cu130

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# HF_TOKEN은 빌드 ARG가 아닌 런타임 ENV로 전달 (이미지 레이어에 토큰 노출 방지)
ENV HF_TOKEN=""

ENTRYPOINT ["./entrypoint.sh"]
