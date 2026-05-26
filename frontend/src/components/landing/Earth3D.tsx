'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface Earth3DProps {
  size?: number;
  className?: string;
}

export default function Earth3D({ size = 360, className }: Earth3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const W = size;
    const H = size;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 100);
    camera.position.set(0, 0, 4.0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const loader = new THREE.TextureLoader();
    const dayMap = loader.load('/textures/earth/earth_day.jpg');
    const normalMap = loader.load('/textures/earth/earth_normal.jpg');
    const cloudMap = loader.load('/textures/earth/earth_clouds.png');
    const lightsMap = loader.load('/textures/earth/earth_lights.png');
    dayMap.colorSpace = THREE.SRGBColorSpace;
    lightsMap.colorSpace = THREE.SRGBColorSpace;

    const earthGeo = new THREE.SphereGeometry(1.0, 128, 64);
    const earthMat = new THREE.MeshPhongMaterial({
      map: dayMap,
      normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      specular: new THREE.Color(0x000000),
      shininess: 0,
      emissiveMap: lightsMap,
      emissive: new THREE.Color(0xffd29a),
      emissiveIntensity: 3.8,
    });
    const earth = new THREE.Mesh(earthGeo, earthMat);

    // 주요 도시 위치 (lat, lon) — 건물 클러스터를 띄울 거점
    const CITIES: Array<[number, number]> = [
      [40.7128, -74.0060],   // New York
      [34.0522, -118.2437],  // Los Angeles
      [41.8781, -87.6298],   // Chicago
      [49.2827, -123.1207],  // Vancouver
      [19.4326, -99.1332],   // Mexico City
      [-23.5505, -46.6333],  // São Paulo
      [-34.6037, -58.3816],  // Buenos Aires
      [51.5074, -0.1278],    // London
      [48.8566, 2.3522],     // Paris
      [52.5200, 13.4050],    // Berlin
      [55.7558, 37.6173],    // Moscow
      [41.0082, 28.9784],    // Istanbul
      [30.0444, 31.2357],    // Cairo
      [25.2048, 55.2708],    // Dubai
      [28.6139, 77.2090],    // Delhi
      [19.0760, 72.8777],    // Mumbai
      [13.7563, 100.5018],   // Bangkok
      [1.3521, 103.8198],    // Singapore
      [22.3193, 114.1694],   // Hong Kong
      [31.2304, 121.4737],   // Shanghai
      [39.9042, 116.4074],   // Beijing
      [37.5665, 126.9780],   // Seoul
      [35.6762, 139.6503],   // Tokyo
      [-33.8688, 151.2093],  // Sydney
      [-26.2041, 28.0473],   // Johannesburg
    ];

    // lat/lon → 3D 구면 좌표 (반지름 r)
    const latLonToVec3 = (lat: number, lon: number, r: number) => {
      const phi = ((90 - lat) * Math.PI) / 180;
      const theta = ((lon + 180) * Math.PI) / 180;
      return new THREE.Vector3(
        -r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
    };

    // === 도시 랜드마크 — Polyhaven CC0 실사 벽 텍스처 + 절차적 야간 창문 ===
    const landmarkGeos: THREE.BufferGeometry[] = [];
    const landmarkMats: THREE.Material[] = [];
    const landmarkTextures: THREE.Texture[] = [];
    const track = <T extends THREE.BufferGeometry>(g: T): T => {
      landmarkGeos.push(g);
      return g;
    };
    const trackMat = <T extends THREE.Material>(m: T): T => {
      landmarkMats.push(m);
      return m;
    };
    const trackTex = <T extends THREE.Texture>(t: T): T => {
      landmarkTextures.push(t);
      return t;
    };

    // 6종 실사 벽 텍스처 풀 (Polyhaven 1K) — 마천루용
    const WALL_PATHS = [
      '/textures/buildings/concrete_wall_007.jpg',
      '/textures/buildings/concrete_wall_006.jpg',
      '/textures/buildings/red_brick_03.jpg',
      '/textures/buildings/brown_planks_03.jpg',
      '/textures/buildings/stone_brick_wall_001.jpg',
      '/textures/buildings/corrugated_iron_03.jpg',
    ];
    const wallPool: THREE.Texture[] = WALL_PATHS.map((p) => {
      const t = trackTex(loader.load(p));
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    });
    // 스톤 텍스처는 모뉴멘트(돔/피라미드/지구라트)에도 쓰임
    const stoneIndex = 4;

    const pickWall = () =>
      wallPool[Math.floor(Math.random() * wallPool.length)];

    // 야간 lit 창문 색 팔레트
    const LIT_COLORS = ['#ffd380', '#a8d8ff', '#ffbc70', '#fff5a3', '#c0e0ff', '#ffaa66'];
    const pickLit = () => LIT_COLORS[Math.floor(Math.random() * LIT_COLORS.length)];

    // 켜진 창문만 그린 emissive 캔버스 (배경 검정 = 발광 없음).
    // map엔 실사 벽 텍스처가 깔리고, 여기에 lit 창문만 더해져 밤 글로우.
    const makeWindowEmissive = (
      cols: number,
      rows: number,
      litChance: number,
      lit: string,
    ): THREE.Texture => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = Math.max(
        128,
        Math.min(512, Math.round((128 * rows) / cols)),
      );
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const cw = canvas.width / cols;
        const rh = canvas.height / rows;
        const winW = cw * 0.58;
        const winH = rh * 0.62;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (Math.random() < litChance) {
              ctx.fillStyle = lit;
              ctx.fillRect(
                c * cw + (cw - winW) / 2,
                r * rh + (rh - winH) / 2,
                winW,
                winH,
              );
            }
          }
        }
      }
      const tex = trackTex(new THREE.CanvasTexture(canvas));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 4;
      return tex;
    };

    // 벽 텍스처를 clone해 face 비율에 맞게 tile.
    // map = 실사 벽, emissiveMap = lit 창문만 → 밤에 창문 글로우
    const makeFacadeMat = (
      wallBase: THREE.Texture,
      repX: number,
      repY: number,
      winTex: THREE.Texture,
    ) => {
      const wall = wallBase.clone();
      wall.wrapS = wall.wrapT = THREE.RepeatWrapping;
      wall.repeat.set(repX, repY);
      wall.colorSpace = THREE.SRGBColorSpace;
      wall.needsUpdate = true;
      trackTex(wall);
      return trackMat(
        new THREE.MeshPhongMaterial({
          map: wall,
          emissiveMap: winTex,
          emissive: new THREE.Color(0xffb060),
          emissiveIntensity: 1.3,
          shininess: 30,
        }),
      );
    };

    // 창문 없는 모뉴멘트 벽 (피라미드·돔·지구라트)
    const makeWallMat = (
      wallBase: THREE.Texture,
      repX: number,
      repY: number,
      tint = 0xffffff,
    ) => {
      const wall = wallBase.clone();
      wall.wrapS = wall.wrapT = THREE.RepeatWrapping;
      wall.repeat.set(repX, repY);
      wall.colorSpace = THREE.SRGBColorSpace;
      wall.needsUpdate = true;
      trackTex(wall);
      return trackMat(
        new THREE.MeshPhongMaterial({
          map: wall,
          color: tint,
          shininess: 18,
        }),
      );
    };

    const makeSolidMat = (color: number, shininess = 20) =>
      trackMat(new THREE.MeshPhongMaterial({ color, shininess }));

    const boxMats = (
      side: THREE.Material,
      top: THREE.Material,
      bottom: THREE.Material,
    ) => [side, side, top, bottom, side, side];

    // 6종 랜드마크 템플릿 — 로컬 (0,0,0)이 지표 접점, +Y가 위.
    const TEMPLATES: Array<() => THREE.Group> = [
      // 1) 모던 마천루 — 실사 벽 + 창문 글로우 + 옥상 + 안테나
      () => {
        const g = new THREE.Group();
        const h = 0.080 + Math.random() * 0.025;
        const wx = 0.026 + Math.random() * 0.012;
        const wz = 0.026 + Math.random() * 0.012;
        const cols = 5 + Math.floor(Math.random() * 3);
        const rows = 18 + Math.floor(Math.random() * 10);
        const winTex = makeWindowEmissive(cols, rows, 0.55, pickLit());
        // 벽 텍스처가 정사각형이라 세로로 긴 면엔 vertical tile 늘림
        const repY = Math.max(1, Math.round(h / wx));
        const fac = makeFacadeMat(pickWall(), 1, repY, winTex);
        const dark = makeSolidMat(0x202428, 15);
        const body = new THREE.Mesh(
          track(new THREE.BoxGeometry(wx, h, wz)),
          boxMats(fac, dark, dark),
        );
        body.position.y = h / 2;
        g.add(body);
        const cap = new THREE.Mesh(
          track(new THREE.BoxGeometry(wx * 0.55, 0.010, wz * 0.55)),
          dark,
        );
        cap.position.y = h + 0.005;
        g.add(cap);
        const ant = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0014, 0.0014, 0.022, 6)),
          makeSolidMat(0xc0c0c0, 60),
        );
        ant.position.y = h + 0.021;
        g.add(ant);
        return g;
      },
      // 2) 와이드 사무용 빌딩 — 실사 벽 + 창문 글로우
      () => {
        const g = new THREE.Group();
        const h = 0.045 + Math.random() * 0.020;
        const wx = 0.050 + Math.random() * 0.015;
        const wz = 0.032 + Math.random() * 0.010;
        const cols = 10 + Math.floor(Math.random() * 4);
        const rows = 7 + Math.floor(Math.random() * 4);
        const winTex = makeWindowEmissive(cols, rows, 0.42, pickLit());
        const repX = Math.max(1, Math.round(wx / 0.025));
        const repY = Math.max(1, Math.round(h / 0.025));
        const fac = makeFacadeMat(pickWall(), repX, repY, winTex);
        const dark = makeSolidMat(0x202428, 15);
        const body = new THREE.Mesh(
          track(new THREE.BoxGeometry(wx, h, wz)),
          boxMats(fac, dark, dark),
        );
        body.position.y = h / 2;
        g.add(body);
        return g;
      },
      // 3) 돔 + 원통 베이스 (의사당 / 모스크 풍) — 스톤 벽 + 단색 돔
      () => {
        const g = new THREE.Group();
        const domeColors = [0xc8a060, 0x8b9a8a, 0x4f5a6a, 0xe8d4a8];
        const domeColor = domeColors[Math.floor(Math.random() * domeColors.length)];
        const baseH = 0.040 + Math.random() * 0.015;
        const baseR = 0.030;
        const base = new THREE.Mesh(
          track(new THREE.CylinderGeometry(baseR, baseR, baseH, 24)),
          makeWallMat(wallPool[stoneIndex], 2, 1, 0xe0d0b0),
        );
        base.position.y = baseH / 2;
        g.add(base);
        const dome = new THREE.Mesh(
          track(
            new THREE.SphereGeometry(baseR * 0.95, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
          ),
          makeSolidMat(domeColor, 80),
        );
        dome.position.y = baseH;
        g.add(dome);
        return g;
      },
      // 4) 피라미드 — 스톤 텍스처 + 사암 틴트
      () => {
        const g = new THREE.Group();
        const tints = [0xc8a37a, 0xb89a6a, 0xa88a5a];
        const tint = tints[Math.floor(Math.random() * tints.length)];
        const h = 0.070 + Math.random() * 0.025;
        const w = 0.058;
        const p = new THREE.Mesh(
          track(new THREE.ConeGeometry(w * 0.7, h, 4)),
          makeWallMat(wallPool[stoneIndex], 1, 1, tint),
        );
        p.position.y = h / 2;
        p.rotation.y = Math.PI / 4;
        g.add(p);
        return g;
      },
      // 5) 첨탑 / 격자 타워 (에펠 풍) — 강철 단색
      () => {
        const g = new THREE.Group();
        const mat = makeSolidMat(0x3a3a3a, 40);
        const h = 0.090 + Math.random() * 0.015;
        const lower = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.008, 0.020, h * 0.65, 4)),
          mat,
        );
        lower.position.y = h * 0.325;
        lower.rotation.y = Math.PI / 4;
        g.add(lower);
        const mid = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.003, 0.008, h * 0.25, 4)),
          mat,
        );
        mid.position.y = h * 0.775;
        mid.rotation.y = Math.PI / 4;
        g.add(mid);
        const top = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0008, 0.003, h * 0.1, 4)),
          mat,
        );
        top.position.y = h * 0.95;
        g.add(top);
        return g;
      },
      // 6) 스텝 피라미드 (지구라트) — 스톤 텍스처 적층
      () => {
        const g = new THREE.Group();
        const tints = [0xa89070, 0x988060, 0x886a52, 0xb8a080];
        const tint = tints[Math.floor(Math.random() * tints.length)];
        const mat = makeWallMat(wallPool[stoneIndex], 1, 1, tint);
        let y = 0;
        for (let i = 0; i < 4; i++) {
          const w = 0.060 - i * 0.012;
          const h = 0.018;
          const m = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, w)), mat);
          m.position.y = y + h / 2;
          g.add(m);
          y += h;
        }
        return g;
      },
    ];

    const up = new THREE.Vector3(0, 1, 0);
    const landmarks: THREE.Group[] = [];
    for (const [cityLat, cityLon] of CITIES) {
      // 도시당 정확히 1개 → 도시 간 거리가 멀어서 절대 겹치지 않음
      const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
      const lm = template();

      const pos = latLonToVec3(cityLat, cityLon, 1.0);
      const radial = pos.clone().normalize();
      lm.quaternion.setFromUnitVectors(up, radial);
      lm.rotateY(Math.random() * Math.PI * 2);
      lm.position.copy(pos);
      // 이전 5x의 절반
      lm.scale.setScalar(2.5);

      earth.add(lm);
      landmarks.push(lm);
    }

    const cloudGeo = new THREE.SphereGeometry(1.012, 96, 48);
    const cloudMat = new THREE.MeshLambertMaterial({
      map: cloudMap,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    const clouds = new THREE.Mesh(cloudGeo, cloudMat);

    // 자전축 23.5° — Group으로 묶어 회전축이 함께 기울도록
    const earthGroup = new THREE.Group();
    earthGroup.rotation.z = THREE.MathUtils.degToRad(23.5);
    earthGroup.add(earth);
    earthGroup.add(clouds);
    scene.add(earthGroup);

    // 대기 글로우 — Fresnel
    const atmoGeo = new THREE.SphereGeometry(1.09, 64, 32);
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        void main() {
          float intensity = pow(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.6);
          gl_FragColor = vec4(0.30, 0.62, 1.0, 1.0) * intensity;
        }
      `,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    });
    const atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
    scene.add(atmosphere);

    // 별 배경
    const STAR_COUNT = 600;
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const r = 18 + Math.random() * 12;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.06,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.75,
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    const sun = new THREE.DirectionalLight(0xffffff, 2.8);
    sun.position.set(5, 1, 3);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.28));

    const SPIN = 0.0018;
    const CLOUD_SPIN = SPIN * 1.18;

    let raf = 0;
    const loop = () => {
      earth.rotation.y += SPIN;
      clouds.rotation.y += CLOUD_SPIN;
      stars.rotation.y += 0.00008;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
      renderer.dispose();
      earthGeo.dispose();
      cloudGeo.dispose();
      atmoGeo.dispose();
      starGeo.dispose();
      for (const g of landmarkGeos) g.dispose();
      earthMat.dispose();
      cloudMat.dispose();
      atmoMat.dispose();
      starMat.dispose();
      for (const m of landmarkMats) m.dispose();
      for (const t of landmarkTextures) t.dispose();
      dayMap.dispose();
      normalMap.dispose();
      cloudMap.dispose();
      lightsMap.dispose();
    };
  }, [size]);

  return (
    <div
      ref={mountRef}
      className={className}
      style={{ width: size, height: size }}
    />
  );
}
