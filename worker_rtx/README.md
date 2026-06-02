# RTX GPU Worker

`worker_rtx/` is a separate Celery worker image for x86_64 NVIDIA RTX GPUs.
It keeps the same task code as `worker_dgx/`, but the image
installs CUDA, PyTorch, COLMAP, pycolmap, Node.js, splat-transform, and
nerfstudio/gsplat inside the container.

Use this folder when the GPU machine is a regular RTX workstation/server rather
than the DGX Spark setup that mounts `/home/imlabdgx1/...` host paths.

## Build

```bash
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml build worker
```

Optional build arguments:

```bash
docker compose -f docker-compose.gpu-rtx.yml build \
  --build-arg GSPLAT_REF=main \
  --build-arg PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cu128 \
  worker
```

## Runtime

The compose file sets:

- `NVIDIA_VISIBLE_DEVICES=all`
- `NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics`
- `TORCH_CUDA_ARCH_LIST=8.6 8.9 12.0+PTX`
- `GSPLAT_PYTHON=/usr/bin/python3`
- `GSPLAT_TRAINER=/opt/gsplat/examples/simple_trainer.py`

RTX 5090/Blackwell uses compute capability 12.0. RTX 30 uses 8.6 and RTX 40
uses 8.9, so the default arch list keeps backward compatibility across these
generations. Override `TORCH_CUDA_ARCH_LIST` in `.env` if the host only needs a
narrower target set.

## Smoke Checks

```bash
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml run --rm worker nvidia-smi
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml run --rm worker python - <<'PY'
import torch
print(torch.cuda.is_available())
print(torch.cuda.get_device_name(0))
PY
docker compose --env-file .env.rtx-worker -f docker-compose.gpu-rtx.yml run --rm sog-worker vulkaninfo --summary
```
