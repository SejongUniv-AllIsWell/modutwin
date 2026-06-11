# GPU Worker 운영 가이드

이 문서는 별도 NVIDIA GPU 머신에서 ModuTwin Celery worker 를 운영하는 절차를 정리한다.

## Worker variants

| Variant | Worker folder | Compose | Target |
| --- | --- | --- | --- |
| DGX Spark | `worker_dgx/` | `docker-compose.gpu-dgx.yml` | DGX Spark/GB10, 기존 `/home/imlabdgx1/...` gsplat host mount |
| RTX | `worker_rtx/` + `door_ml_rtx/` | `docker-compose.gpu-rtx.yml` | x86_64 RTX 30/40/50+ NVIDIA GPU, container-internal CUDA/PyTorch/gsplat/SAM3 |

`worker_rtx/` 는 task 이름과 큐 이름을 기존 DGX worker 와 동일하게 유지한다. 따라서 backend dispatch 변경 없이 `training`, `alignment`, `sog` 큐를 소비한다. DGX worker 와 RTX worker 를 동시에 띄우면 같은 큐에서 load-balance 된다.

## 역할

PC 웹 스택은 `nginx`, `frontend`, `backend`, `postgres`, `redis`, `rabbitmq`, `minio`만 실행한다. GPU 머신은 아래 서비스를 실행한다.

| Service | Queue / API | Purpose |
| --- | --- | --- |
| `worker` | Celery `training,alignment` | COLMAP 전처리, gsplat 학습, 문 정합 |
| `sog-worker` | Celery `sog` | refined PLY -> SOG 변환 |
| `door-ml` | HTTP `:8100` | SAM3 문 검출 (DGX/RTX compose 에 포함) |

## 사전 조건

GPU 머신:

- NVIDIA Container Toolkit 설치
- Docker Compose v2 사용
- 프로젝트 `.env`에 PC와 같은 broker/storage 비밀값 설정
- `PC_HOST_IP`가 PC 웹 서버의 LAN/Tailscale IP를 가리킴
- `HF_TOKEN` 설정(SAM3 gated model 접근용, door-ml 운영 시 필요)

PC 웹 서버:

- `docker-compose.yml` 스택 실행
- RabbitMQ `5673`, Redis `6379`, MinIO `9000`이 GPU 머신에서 접근 가능
- SAM3 사용 시 backend `.env`에 아래 설정

```env
ENABLE_SAM3_DISPATCH=true
DOOR_ML_URL=http://<GPU_MACHINE_IP>:8100
```

GPU 머신에서 PC 연결 확인:

```bash
nc -zv $PC_HOST_IP 5673
nc -zv $PC_HOST_IP 6379
nc -zv $PC_HOST_IP 9000
```

## SOG GPU 변환 조건

SOG converter는 CUDA가 아니라 `WebGPU(Dawn) -> Vulkan` 경로를 사용한다. 따라서 컨테이너 내부에서 NVIDIA Vulkan adapter가 보여야 GPU 변환을 사용한다.

`.env` 기본 권장값:

```env
SOG_DEVICE=auto
SOG_DAWN_BACKEND=vulkan
SOG_PREFER_NVIDIA=1
SOG_ITERATIONS=10
SOG_TIMEOUT=3600
```

`SOG_DEVICE=auto`는 NVIDIA/Vulkan hardware adapter를 우선 선택한다. adapter가 없거나 변환이 실패하면 각 worker 의 `tasks/sog.py`가 CPU 변환으로 자동 폴백한다. `llvmpipe`, `lavapipe`, `SwiftShader` 같은 software Vulkan만 보이면 GPU로 간주하지 않고 CPU fallback을 사용한다.

RTX 30/40/50, RTX A/Ada/Blackwell 계열은 같은 방식으로 처리한다. DGX Spark/GB10 같은 Blackwell 시스템은 호스트 driver와 Vulkan ICD가 특히 중요하다.

호스트에서 확인:

```bash
nvidia-smi
vulkaninfo --summary
```

컨테이너에서 확인:

```bash
docker exec 3dgs-dgx-sog-worker vulkaninfo --summary
docker exec 3dgs-rtx-sog-worker vulkaninfo --summary
```

정상 GPU 경로라면 로그에 아래 형태가 나온다.

```text
Selected GPU adapter 0: backend=vulkan, name=NVIDIA ...
```

`vulkaninfo`에 `llvmpipe`만 나오면 NVIDIA Vulkan driver/ICD가 컨테이너에 노출되지 않은 상태다. 이 경우 SOG는 CPU로 변환된다.

DGX Spark/GB10에서 NVIDIA Vulkan adapter가 안 보이면 호스트에 NVIDIA OpenGL/Vulkan 드라이버 패키지가 있는지 확인한다. 예: driver 580 계열에서는 `libnvidia-gl-580` 패키지가 필요할 수 있다.

## RTX 실행

RTX worker 는 `worker_rtx/` 이미지를 사용한다. door-ml 은 `door_ml_rtx/` 이미지를 사용한다. 두 이미지는 컨테이너 내부에 CUDA/PyTorch/gsplat/SAM3 환경을 설치하므로 DGX 의 `/home/imlabdgx1/...` 경로 마운트가 필요 없다.

GPU 머신에서:

```bash
git pull

cp .env.rtx-worker.example .env.rtx-worker
# .env.rtx-worker 에 PC_HOST_IP + PC 와 동일한 비밀값 입력

docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml up -d --build
```

서비스 확인:

```bash
docker ps --format 'table {{.Names}}	{{.Status}}'
docker logs 3dgs-rtx-worker --since 5m
docker logs 3dgs-rtx-sog-worker --since 5m
docker logs 3dgs-rtx-door-ml --since 5m
```

GPU/CUDA smoke check:

```bash
docker exec 3dgs-rtx-worker nvidia-smi
docker exec 3dgs-rtx-worker python -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
docker exec 3dgs-rtx-worker python -c "import celery_app, tasks.training, tasks.colmap, tasks.alignment, tasks.sog; print('imports ok')"
docker exec 3dgs-rtx-worker bash -lc 'colmap -h | tee /tmp/colmap-help.txt && ! grep -qi "without CUDA" /tmp/colmap-help.txt'
docker exec 3dgs-rtx-worker bash -lc 'test -f "$GSPLAT_TRAINER" && node --version'
docker exec 3dgs-rtx-sog-worker vulkaninfo --summary
curl -i http://127.0.0.1:8100/health
```

SOG worker만 재시작:

```bash
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml up -d --build sog-worker
```

## DGX Spark 실행

DGX Spark 는 기존 `worker_dgx/` 이미지와 host-mounted gsplat 경로를 사용한다.

```bash
git pull

cp .env.dgx-worker.example .env.dgx-worker
# .env.dgx-worker 에 PC_HOST_IP + PC 와 동일한 비밀값 입력

docker compose --env-file .env.dgx-worker -f docker-compose.gpu-dgx.yml up -d --build
```

서비스 확인:

```bash
docker ps --format 'table {{.Names}}	{{.Status}}	{{.Ports}}'
docker logs 3dgs-dgx-worker --since 5m
docker logs 3dgs-dgx-sog-worker --since 5m
docker logs 3dgs-door-ml --since 5m
```

SOG worker만 재시작:

```bash
docker compose --env-file .env.dgx-worker -f docker-compose.gpu-dgx.yml up -d --build sog-worker
```

로그 tail:

```bash
docker logs -f 3dgs-dgx-sog-worker
```

## 배포 순서

SOG 큐 이름은 `sog`다. queue publish 쪽 backend와 consume 쪽 `sog-worker`가 같이 맞아야 한다.

권장 순서:

1. GPU 머신에서 사용할 worker compose(`docker-compose.gpu-dgx.yml` 또는 `docker-compose.gpu-rtx.yml`) 먼저 배포
2. PC 웹 서버 backend/frontend/nginx 배포

순서가 반대여도 메시지는 durable `sog` 큐에 잠시 쌓이고, `sog-worker`가 올라오면 처리된다. 단, 그 동안 viewer는 `sog_path` 없이 canonical PLY로 fallback한다.

## CPU 강제 모드

WSL Ubuntu, Vulkan 미지원 환경, 또는 GPU 변환이 불안정한 환경에서는 CPU 고정을 권장한다.

```env
SOG_DEVICE=cpu
```

CPU 모드는 느리지만 GPU/Vulkan 설정에 의존하지 않는다.

## 문제 해결

### `Selected GPU adapter` 로그가 없다

```bash
docker exec 3dgs-dgx-sog-worker vulkaninfo --summary
docker exec 3dgs-rtx-sog-worker vulkaninfo --summary
```

NVIDIA adapter가 없으면 호스트 driver/ICD 또는 NVIDIA Container Toolkit 설정 문제다. SOG는 CPU fallback으로 처리된다.

### `llvmpipe`만 보인다

software Vulkan만 잡힌 상태다. NVIDIA Vulkan driver가 호스트에 없거나 컨테이너에 graphics capability가 노출되지 않은 것이다. 호스트의 NVIDIA GL/Vulkan 패키지와 compose의 `NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics`를 확인한다.

### SOG 변환 타임아웃

PLY가 크면 CPU fallback이 오래 걸린다. 필요하면 `.env`에서 timeout을 늘린다.

```env
SOG_TIMEOUT=7200
```

### SOG가 없어도 viewer가 열림

정상이다. SOG는 viewer 최적화 파생물이고 canonical asset은 PLY다. SOG 변환 실패 또는 지연 시 backend는 PLY URL로 fallback한다.
