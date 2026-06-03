# RTX door-ml 서비스
#
# SAM3 공식 prerequisites (2025-05):
#   Python 3.12+, CUDA 12.6+, PyTorch 2.7+
#   Source: https://github.com/facebookresearch/sam3
#
# facebook/sam3 는 HuggingFace gated 모델이므로
# HF_TOKEN 환경변수가 반드시 필요하다 (.env 또는 compose env 주입).
# 체크포인트는 컨테이너 최초 기동 시 다운로드되고 이후 볼륨에 캐싱된다.
#
# RTX 5090(Blackwell, sm_120)을 기준으로 CUDA 12.8 / PyTorch cu128을 사용한다.
# TORCH_CUDA_ARCH_LIST 기본값은 RTX 30(Ampere), RTX 40(Ada), RTX 50(Blackwell)
# 를 한 이미지에서 처리하도록 넓게 둔다.
#
# devel 이미지 사용 이유: gsplat 은 nvcc 가 있어야 CUDA extension 을
# AOT/JIT 컴파일한다. runtime 이미지엔 nvcc 가 없어 'NoneType' has no
# attribute 'CameraModelType' 발생.

FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    TORCH_CUDA_ARCH_LIST="8.6 8.9 12.0+PTX"

# Ubuntu 24.04는 기본 Python 3.12 제공
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-dev python3-pip \
        libgl1 libglib2.0-0 \
        curl ca-certificates \
        git \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cu128

# PyTorch + torchvision (CUDA 12.8 빌드). torchvision 도 같은 인덱스에서 받아야 torch 와 ABI 호환.
RUN python3 -m pip install --no-cache-dir --ignore-installed "setuptools<81" wheel \
    && python3 -m pip install --no-cache-dir torch torchvision --index-url "${PYTORCH_INDEX_URL}"

COPY requirements.txt .
RUN python3 -m pip install --no-cache-dir -r requirements.txt

COPY main.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# HF_TOKEN은 빌드 ARG가 아닌 런타임 ENV로 전달 (이미지 레이어에 토큰 노출 방지)
ENV HF_TOKEN=""

ENTRYPOINT ["./entrypoint.sh"]
