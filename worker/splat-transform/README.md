# splat-to-sog (trimmed splat-transform)

PlayCanvas [splat-transform](https://github.com/playcanvas/splat-transform) 를
**Gaussian Splat → SOG 변환 파이프라인만** 남기고 트리밍한 빌드입니다. ModuTwin
워커가 이 CLI 를 subprocess 로 호출합니다.

## 지원 변환

| 입력 | 출력 |
| ---- | ---- |
| `.ply` | `.sog` |
| `.compressed.ply` (자동 압축 해제) | `.sog` |
| `.sog` / `meta.json` | `.sog` |
| `.splat` (antimatter15) | `.sog` |
| `.spz` (Niantic v2–4) | `.sog` |

그 외 입력 리더(ksplat, lcc, mjs)와 SOG 이외의 모든 라이터(ply, spz, glb, csv,
html, lod, voxel, image), 그리고 voxel/mesh/render/process 서브시스템은 제거했습니다.

## 빌드

```bash
npm ci          # 또는 npm install
npm run build   # dist/cli.mjs 생성
```

## 사용법

```bash
node bin/cli.mjs [OPTIONS] <input> [output]
```

- `output` 을 생략하면 입력과 **동일한 폴더**에 `<basename>.sog` 로 저장합니다.
- 기본 디바이스는 **CPU** 라 GPU 없이 동작합니다 (`webgpu` 는 optionalDependency).

```bash
node bin/cli.mjs input.ply                       # → input.sog
node bin/cli.mjs input.compressed.ply            # → input.sog
node bin/cli.mjs -w -i 20 scene.spz scene.sog    # 반복 20회, 덮어쓰기
node bin/cli.mjs -g auto input.ply               # GPU 사용 (webgpu 설치 필요)
```

| 옵션 | 설명 |
| ---- | ---- |
| `-w, --overwrite` | 출력 파일이 있으면 덮어쓰기 |
| `-i, --iterations <n>` | SH 압축 반복 횟수 (기본 10) |
| `-g, --gpu <n\|cpu\|auto>` | SH 클러스터링 디바이스 (기본 cpu) |
| `-q, --quiet` / `--verbose` | 로그 레벨 |

라이선스는 원본과 동일하게 MIT (LICENSE 참고).
