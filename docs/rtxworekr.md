# RTX Worker 운영 절차

Ubuntu 22.04 + RTX 5090 PC를 기준으로 원격 Celery worker를 실행하는 절차다.
이 RTX worker는 `worker_rtx/` 이미지를 사용하고, PC 웹 서버의 RabbitMQ/Redis/MinIO/backend에 붙어서 `training`, `alignment`, `sog` 큐를 소비한다. 같은 RTX compose에서 `door_ml_rtx/` 기반 `door-ml`도 함께 실행한다.

기본 설정은 CUDA 12.8 / PyTorch cu128을 사용한다. `TORCH_CUDA_ARCH_LIST=8.6 8.9 12.0+PTX`로 두어 gsplat 빌드는 RTX 30(Ampere), RTX 40(Ada), RTX 50(Blackwell) 계열을 같은 이미지에서 지원한다. COLMAP은 apt 패키지 대신 CUDA 지원 source build로 설치하며, `COLMAP_CUDA_ARCHITECTURES` 기본값은 RTX 3070/RTX 30용 `86`이다.

SAM3 자동 문 검출을 쓰려면 RTX PC의 `door-ml` 포트(`8100`)를 PC backend에서 접근할 수 있어야 한다.

## 구조

| 구분 | 값 |
| --- | --- |
| Worker folder | `worker_rtx/` |
| Door ML folder | `door_ml_rtx/` |
| Compose file | `docker-compose.gpu-rtx.yml` |
| Env file | `.env.rtx-worker` |
| Containers | `3dgs-rtx-worker`, `3dgs-rtx-sog-worker`, `3dgs-rtx-door-ml` |
| Images | `modutwin-worker-rtx`, `modutwin-door-ml-rtx` |
| Door ML API | `http://<RTX_IP>:8100/health`, `POST /detect` |
| Worker CUDA image | `nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04` |
| Door ML CUDA image | `nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04` |
| PyTorch wheel index | `https://download.pytorch.org/whl/cu128` |
| Default arch list | `TORCH_CUDA_ARCH_LIST=8.6 8.9 12.0+PTX`, `COLMAP_CUDA_ARCHITECTURES=86` |
| RTX 5090 arch | Blackwell, `12.0` |
| RTX 30 arch | Ampere, `8.6` |

## RTX PC 사전 준비

RTX PC에는 아래가 필요하다.

- Ubuntu 22.04 x86_64
- NVIDIA driver
- Docker Engine + Docker Compose plugin
- NVIDIA Container Toolkit
- PC 웹 서버의 RabbitMQ `5673`, Redis `6379`, MinIO `9000`, backend callback URL에 접근 가능한 네트워크
- PC backend에서 RTX PC의 door-ml `8100` 포트에 접근 가능한 네트워크
- `HF_TOKEN` (facebook/sam3 gated 모델 접근용 HuggingFace read token)

공식 설치 문서:

- Docker Engine on Ubuntu: https://docs.docker.com/engine/install/ubuntu/
- NVIDIA Container Toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html

### Driver 확인

```bash
nvidia-smi
```

RTX worker Dockerfile은 CUDA 12.8 PyTorch wheel을 사용한다. `nvidia-smi`의 CUDA Version이 12.8 이상을 지원하는 드라이버를 권장한다. RTX 5090은 특히 최신 NVIDIA driver가 필요하다. 오래된 드라이버면 먼저 NVIDIA driver를 업데이트하고 재부팅한다.

### Docker 확인

```bash
docker --version
docker compose version
```

현재 사용자를 docker 그룹에 넣었다면 재로그인 후 확인한다.

```bash
sudo usermod -aG docker "$USER"
```

### NVIDIA Container Toolkit 확인

설치 후 Docker runtime을 설정하고 Docker를 재시작한다.

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

GPU passthrough smoke check:

```bash
docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu22.04 nvidia-smi
```

## PC 웹 서버 준비

PC 웹 서버는 base stack만 실행한다.

```bash
docker compose up -d
```

PC `.env`에서 아래 값이 RTX PC에서 접근 가능한 값이어야 한다.

```env
PC_HOST_IP=<PC_LAN_OR_TAILSCALE_IP>
RABBITMQ_DEFAULT_USER=...
RABBITMQ_DEFAULT_PASS=...
REDIS_PASSWORD=...
MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
MINIO_BUCKET=3dgs-platform
WORKER_CALLBACK_TOKEN=...
```

SAM3 자동 문 검출을 RTX PC의 door-ml로 보내려면 PC 웹 서버 `.env`에 아래도 설정하고 backend를 재시작한다.

```env
ENABLE_SAM3_DISPATCH=true
DOOR_ML_URL=http://<RTX_PC_IP>:8100
```

RTX PC에서 PC 웹 서버 접근을 확인한다.

```bash
nc -zv <PC_HOST_IP> 5673
nc -zv <PC_HOST_IP> 6379
nc -zv <PC_HOST_IP> 9000
```

PC 웹 서버에서 RTX door-ml `8100` 포트에 접근 가능하도록 방화벽/Tailscale ACL도 준비한다. health check는 RTX compose 실행 후 진행한다.

nginx를 통해 backend callback을 받을 때는 RTX worker의 `BACKEND_CALLBACK_URL`을 보통 `http://<PC_HOST_IP>/api`로 둔다. backend `8000` 포트를 직접 열어 쓰는 경우에는 `http://<PC_HOST_IP>:8000`을 쓴다.

콜백 URL 확인 예시:

```bash
curl -i http://<PC_HOST_IP>/api/health
# 또는 backend 직접 접근 시
curl -i http://<PC_HOST_IP>:8000/health
```

## 원격 repo pull 후 RTX PC에서 할 일

RTX PC에서 repo를 받은 뒤:

```bash
cd /path/to/modutwin
git pull
```

env 파일을 만든다.

```bash
cp .env.rtx-worker.example .env.rtx-worker
```

`.env.rtx-worker`를 편집한다.

```env
PC_HOST_IP=<PC_LAN_OR_TAILSCALE_IP>

RABBITMQ_DEFAULT_USER=<PC .env와 동일>
RABBITMQ_DEFAULT_PASS=<PC .env와 동일>
REDIS_PASSWORD=<PC .env와 동일>

MINIO_ACCESS_KEY=<PC .env와 동일>
MINIO_SECRET_KEY=<PC .env와 동일>
MINIO_BUCKET=3dgs-platform

# nginx 경유면 /api 포함
BACKEND_CALLBACK_URL=http://<PC_HOST_IP>/api
WORKER_CALLBACK_TOKEN=<PC .env와 동일>

# 보통 BACKEND_CALLBACK_URL과 동일하게 둔다.
BACKEND_INTERNAL_URL=http://<PC_HOST_IP>/api
INTERNAL_API_TOKEN=

# door-ml / SAM3
HF_TOKEN=<HuggingFace read token>
DOOR_ML_PORT=8100

# RTX 5090 기준 + RTX 30/40 하위 호환
TORCH_CUDA_ARCH_LIST=8.6 8.9 12.0+PTX
PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
GSPLAT_REF=main
GSPLAT_MAX_STEPS=30000
WORKER_SHM_SIZE=12gb

# COLMAP CUDA source build
# RTX 30=86, RTX 40=89, RTX 50=120
COLMAP_REF=3.12.6
COLMAP_CUDA_ARCHITECTURES=86

SOG_DEVICE=auto
SOG_DAWN_BACKEND=vulkan
SOG_PREFER_NVIDIA=1
SOG_ITERATIONS=10
SOG_TIMEOUT=3600

NVIDIA_VISIBLE_DEVICES=all
NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics
```

compose 설정을 먼저 검증한다.

```bash
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml config
```

처음 빌드는 PyTorch, gsplat, Node dependency 설치 때문에 오래 걸릴 수 있다.

```bash
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml up -d --build
```

## 실행 확인

컨테이너 상태:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
```

기본 로그:

```bash
docker logs 3dgs-rtx-worker --since 10m
docker logs 3dgs-rtx-sog-worker --since 10m
docker logs 3dgs-rtx-door-ml --since 10m
```

worker import/CUDA 확인:

```bash
docker exec 3dgs-rtx-worker nvidia-smi
docker exec 3dgs-rtx-worker python -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
docker exec 3dgs-rtx-worker python -c "import celery_app, tasks.training, tasks.colmap, tasks.alignment, tasks.sog; print('imports ok')"
docker exec 3dgs-rtx-worker bash -lc 'colmap -h | tee /tmp/colmap-help.txt && ! grep -qi "without CUDA" /tmp/colmap-help.txt'
docker exec 3dgs-rtx-worker bash -lc 'test -f "$GSPLAT_TRAINER" && node --version'
```

door-ml 확인:

```bash
curl -i http://127.0.0.1:8100/health
curl -i http://<RTX_PC_IP>:8100/health
docker exec 3dgs-rtx-door-ml python -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
docker exec 3dgs-rtx-door-ml python -c "import core.door_detection.pipeline; print('door pipeline import ok')"
```

SOG Vulkan 확인:

```bash
docker exec 3dgs-rtx-sog-worker vulkaninfo --summary
```

정상 GPU 경로라면 SOG 변환 로그에 NVIDIA/Vulkan adapter 선택 로그가 나온다. NVIDIA adapter가 안 보이면 `SOG_DEVICE=auto` 상태에서도 CPU fallback으로 처리될 수 있다.

PC RabbitMQ에서 큐 consumer를 확인한다.

```bash
docker exec 3dgs-rabbitmq rabbitmqctl list_queues name consumers
```

기대값:

- `training` consumers >= 1
- `alignment` consumers >= 1
- `sog` consumers >= 1

## 업데이트

RTX PC에서 repo 업데이트 후 재배포:

```bash
git pull
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml up -d --build
```

SOG worker만 재시작:

```bash
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml up -d --build sog-worker
```

중지:

```bash
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml down
```

## 문제 해결

### `torch.cuda.is_available()`가 `False`

- 호스트에서 `nvidia-smi`가 되는지 확인한다.
- `docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu22.04 nvidia-smi`가 되는지 확인한다.
- NVIDIA Container Toolkit 설정 후 Docker를 재시작했는지 확인한다.
- 호스트 NVIDIA driver가 CUDA 12.8 컨테이너를 지원할 만큼 최신인지 확인한다.

### `vulkaninfo`에 NVIDIA adapter가 없다

SOG GPU 변환은 CUDA가 아니라 WebGPU(Dawn) -> Vulkan 경로를 쓴다. 호스트 NVIDIA Vulkan/graphics driver가 없거나 컨테이너에 `graphics` capability가 노출되지 않으면 CPU fallback이 된다.

확인할 값:

```env
NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics
SOG_DEVICE=auto
SOG_DAWN_BACKEND=vulkan
SOG_PREFER_NVIDIA=1
```

### PC 서비스에 연결 실패

RTX PC에서 아래를 다시 확인한다.

```bash
nc -zv $PC_HOST_IP 5673
nc -zv $PC_HOST_IP 6379
nc -zv $PC_HOST_IP 9000
curl -i "$BACKEND_CALLBACK_URL/health"
```

PC 방화벽, Tailscale ACL, PC `.env`의 `PC_HOST_IP` 바인딩을 같이 확인한다.

### callback 401/403

`WORKER_CALLBACK_TOKEN`이 PC 웹 서버 `.env`와 RTX worker `.env.rtx-worker`에서 같은지 확인한다.

### door-ml 컨테이너가 바로 종료됨

`HF_TOKEN`이 비어 있으면 `3dgs-rtx-door-ml`은 시작 시 종료된다. `.env.rtx-worker`에 HuggingFace read token을 넣고 다시 올린다.

```bash
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml up -d --build door-ml
docker logs 3dgs-rtx-door-ml --since 5m
```

### PC backend에서 자동 문 검출이 안 됨

PC 웹 서버 `.env`를 확인한다.

```env
ENABLE_SAM3_DISPATCH=true
DOOR_ML_URL=http://<RTX_PC_IP>:8100
```

그 다음 PC backend를 재시작하고 RTX PC에서 door-ml health를 확인한다.

### RTX 30 시리즈 PC에서도 그대로 쓸 수 있나

쓸 수 있다. 기본 arch list가 RTX 30(Ampere)용 `8.6`을 포함한다.

```env
TORCH_CUDA_ARCH_LIST=8.6 8.9 12.0+PTX
COLMAP_CUDA_ARCHITECTURES=86
PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
```

단, RTX 30 시리즈만 쓰는 PC에서 빌드 시간을 줄이고 싶다면 아래처럼 좁힐 수 있다.

```env
TORCH_CUDA_ARCH_LIST=8.6
COLMAP_CUDA_ARCHITECTURES=86
```

이 경우 해당 이미지가 RTX 5090에서는 Blackwell용 CUDA extension을 다시 빌드해야 할 수 있으므로, 여러 RTX 세대에서 이미지를 재사용하려면 기본값을 유지한다.

### 기준 근거

- NVIDIA Blackwell compatibility guide는 CUDA Toolkit 12.8 기준 Blackwell 호환성을 설명한다: https://docs.nvidia.com/cuda/archive/12.8.2/blackwell-compatibility-guide/index.html
- PyTorch 공식 previous versions에는 CUDA 12.8 wheel index(`cu128`)가 제공된다: https://pytorch.org/get-started/previous-versions/
- NVIDIA cuDNN 페이지는 CUDA 12.8.1 cuDNN devel Ubuntu 22.04 이미지를 예시로 제시한다: https://developer.nvidia.com/cudnn
