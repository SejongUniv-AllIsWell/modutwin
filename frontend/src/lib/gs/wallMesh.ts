import type { TextureBakeResult, Vec3 } from './textureBake';

/**
 * Bake 결과로 PlayCanvas quad mesh 엔티티를 생성한다.
 *
 * - app.root에 추가하고 Z-180만 직접 부여
 *   bake 좌표는 이미 (raw + pendingRotation) 프레임이므로 Z-180만 한 번 적용해야 splat과 정렬됨.
 *   splatEntity의 child로 붙이면 splatEntity transform(Z-180 ∘ pendingRotation)이 상속돼
 *   pendingRotation이 이중 적용되는 버그 발생.
 * - 머티리얼: emissiveMap (unlit), 양면 렌더 (CULLFACE_NONE) — 면별 winding 차이로 인한 누락 방지
 *
 * 반환: 생성된 entity. 호출자가 .destroy() 책임.
 */
export interface WallMeshOptions {
  /** true면 텍스처 무시하고 단색 흰색 불투명 메시. 지오메트리 검증용 디버그 모드. */
  solidWhite?: boolean;
}

function averageOpaqueColor(rgba: Uint8ClampedArray | Uint8Array): [number, number, number] | null {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a <= 0) continue;
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
    n++;
  }
  return n > 0 ? [r / (255 * n), g / (255 * n), b / (255 * n)] : null;
}

export function createWallMeshEntity(
  pc: any,
  app: any,
  _splatEntity: any,
  bake: TextureBakeResult,
  name = 'wallMesh',
  opts: WallMeshOptions = {},
): any {
  const device = app.graphicsDevice;

  // ── 머티리얼 (unlit) ──
  const mat = new pc.StandardMaterial();
  mat.useLighting = false;
  mat.diffuse.set(0, 0, 0);
  mat.cull = pc.CULLFACE_NONE;

  if (opts.solidWhite) {
    // 디버그: 단색 흰색 불투명. 메시 위치/방향만 검증.
    mat.emissive.set(1, 1, 1);
  } else {
    // ── 텍스처 ──
    const fmt = pc.PIXELFORMAT_SRGBA8 ?? pc.PIXELFORMAT_RGBA8;
    const tex = new pc.Texture(device, {
      width: bake.width,
      height: bake.height,
      format: fmt,
      mipmaps: false, // mipmap 미생성 — raw 데이터만 사용. mip alpha 평균으로 컷되는 문제 회피
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
      magFilter: pc.FILTER_LINEAR,
      minFilter: pc.FILTER_LINEAR,
      name,
    });
    const lvl = tex.lock();
    lvl.set(bake.rgba);
    tex.unlock();

    mat.emissive.set(1, 1, 1);
    mat.emissiveMap = tex;
    // 알파 컷오프: 사용자가 투명 영역으로 페인트한 픽셀(alpha=0) 만 discard.
    // 임계값은 8-bit 알파 기준 "정확히 0인 픽셀만 컷" 에 해당하는 1/255.
    // 0.5 같은 표준 cutout 임계값을 쓰면 베이크의 부분 알파 (가장자리/sparse coverage)
    // 까지 통째로 잘려서 검은 구멍 아티팩트 발생.
    mat.opacityMap = tex;
    mat.opacityMapChannel = 'a';
    mat.alphaTest = 1 / 255;
    mat.blendType = pc.BLEND_NONE;
  }
  mat.update();

  // ── Quad 메시 ──
  // corners: TL, TR, BR, BL
  const [tl, tr, br, bl] = bake.corners;
  const positions = [
    tl[0], tl[1], tl[2],
    tr[0], tr[1], tr[2],
    br[0], br[1], br[2],
    bl[0], bl[1], bl[2],
  ];
  // UV — bake가 계산한 값 사용. extend가 있으면 [0,1] 밖으로 나가서 clamp-to-edge로 가장자리 복제됨.
  const u = bake.uvs;
  const uvs = [
    u[0][0], u[0][1],  // TL
    u[1][0], u[1][1],  // TR
    u[2][0], u[2][1],  // BR
    u[3][0], u[3][1],  // BL
  ];

  // 노멀 — plane.normal의 반대 (방 안쪽을 향함)
  const n: Vec3 = [-bake.input.normal[0], -bake.input.normal[1], -bake.input.normal[2]];
  const normals = [
    n[0], n[1], n[2],
    n[0], n[1], n[2],
    n[0], n[1], n[2],
    n[0], n[1], n[2],
  ];

  const indices = [0, 1, 2, 0, 2, 3];

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update();

  const meshInstance = new pc.MeshInstance(mesh, mat);

  const ent = new pc.Entity(name);
  ent.addComponent('render', { meshInstances: [meshInstance] });
  (ent as any).__averageColor = opts.solidWhite ? [1, 1, 1] : averageOpaqueColor(bake.rgba);
  // Z-180만 직접 부여.
  ent.setLocalEulerAngles(0, 0, 180);
  app.root.addChild(ent);

  return ent;
}

/**
 * 영속화된 메타데이터 + 텍스처 이미지로 wall mesh 엔티티 생성.
 * 베이크된 결과 PNG (HTMLImageElement) 와 메시 메타 (corners, uvs, normalInward) 를 받아서
 * createWallMeshEntity 와 동일한 로직으로 메시 만듦.
 *
 * 반환: 생성된 entity. 호출자가 .destroy() 책임.
 */
export interface PersistedMeshData {
  surfaceId: string;
  corners: number[][];      // 4 × 3 (TL, TR, BR, BL)
  uvs: number[][];          // 4 × 2 (TL, TR, BR, BL)
  normalInward: [number, number, number];
  textureImage: HTMLImageElement;
}

export function createWallMeshFromPersisted(
  pc: any,
  app: any,
  data: PersistedMeshData,
  opts: {
    mutableTexture?: boolean;
    onTextureData?: (texture: { rgba: Uint8ClampedArray; width: number; height: number }) => void;
  } = {},
): any {
  const device = app.graphicsDevice;
  const name = `wallMesh_${data.surfaceId}`;

  // 머티리얼 (unlit emissive)
  const mat = new pc.StandardMaterial();
  mat.useLighting = false;
  mat.diffuse.set(0, 0, 0);
  mat.cull = pc.CULLFACE_NONE;

  // PNG 이미지를 PlayCanvas Texture 로 변환
  const fmt = pc.PIXELFORMAT_SRGBA8 ?? pc.PIXELFORMAT_RGBA8;
  const tex = new pc.Texture(device, {
    width: data.textureImage.naturalWidth,
    height: data.textureImage.naturalHeight,
    format: fmt,
    mipmaps: false,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    magFilter: pc.FILTER_LINEAR,
    minFilter: pc.FILTER_LINEAR,
    name,
  });
  // 문 설정/정합 단계처럼 텍스처 alpha punch 를 수정해야 하는 화면은 mutableTexture=true
  // 기본 경로를 사용한다. 층 overview 처럼 read-only 로 보기만 하는 화면은 setSource 로
  // 업로드해 큰 ImageData 복사를 피한다.
  let averageColor: [number, number, number] | null = null;
  if (opts.mutableTexture !== false) {
    const canvas = document.createElement('canvas');
    canvas.width = data.textureImage.naturalWidth;
    canvas.height = data.textureImage.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(data.textureImage, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    averageColor = averageOpaqueColor(imgData.data);
    opts.onTextureData?.({
      rgba: new Uint8ClampedArray(imgData.data),
      width: canvas.width,
      height: canvas.height,
    });
    const lvl = tex.lock();
    lvl.set(imgData.data);
    tex.unlock();
  } else if (typeof tex.setSource === 'function') {
    tex.setSource(data.textureImage);
  }

  mat.emissive.set(1, 1, 1);
  mat.emissiveMap = tex;
  // 도어 정합 단계에서 wall mesh 텍스처에 도어 영역 alpha=0 punch 가 들어옴 →
  // alphaTest cutout 이 있어야 punch 된 픽셀이 실제로 사라짐. (createWallMeshEntity 와 동일.)
  mat.opacityMap = tex;
  mat.opacityMapChannel = 'a';
  mat.alphaTest = 1 / 255;
  mat.blendType = pc.BLEND_NONE;
  mat.update();

  // Quad 메시
  const [tl, tr, br, bl] = data.corners;
  const positions = [
    tl[0], tl[1], tl[2],
    tr[0], tr[1], tr[2],
    br[0], br[1], br[2],
    bl[0], bl[1], bl[2],
  ];
  const u = data.uvs;
  const uvs = [
    u[0][0], u[0][1],
    u[1][0], u[1][1],
    u[2][0], u[2][1],
    u[3][0], u[3][1],
  ];
  const n = data.normalInward;
  const normals = [
    n[0], n[1], n[2],
    n[0], n[1], n[2],
    n[0], n[1], n[2],
    n[0], n[1], n[2],
  ];
  const indices = [0, 1, 2, 0, 2, 3];

  const mesh = new pc.Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update();

  const meshInstance = new pc.MeshInstance(mesh, mat);

  const ent = new pc.Entity(name);
  ent.addComponent('render', { meshInstances: [meshInstance] });
  (ent as any).__averageColor = averageColor;
  // Z-180 (저장된 corners 는 raw PLY 프레임 기준)
  ent.setLocalEulerAngles(0, 0, 180);
  app.root.addChild(ent);

  return ent;
}
