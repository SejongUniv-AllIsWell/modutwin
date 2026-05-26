'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';

export interface Earth3DHandle {
  triggerZoom: (onComplete: () => void) => void;
}

interface Earth3DProps {
  size?: number;
  className?: string;
  onClick?: () => void;
}

const Earth3D = forwardRef<Earth3DHandle, Earth3DProps>(function Earth3D(
  { size = 360, className, onClick },
  ref,
) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{ triggerZoom: (cb: () => void) => void } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      triggerZoom: (cb) => apiRef.current?.triggerZoom(cb),
    }),
    [],
  );

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
    const specMap = loader.load('/textures/earth/earth_specular.jpg');
    const normalMap = loader.load('/textures/earth/earth_normal.jpg');
    const cloudMap = loader.load('/textures/earth/earth_clouds.png');
    const lightsMap = loader.load('/textures/earth/earth_lights.png');
    dayMap.colorSpace = THREE.SRGBColorSpace;
    lightsMap.colorSpace = THREE.SRGBColorSpace;

    const earthGeo = new THREE.SphereGeometry(1.0, 128, 64);
    // emissiveMap = 야간 도시 불빛. day side는 강한 diffuse에 묻히고 night side에서 도드라짐.
    // emissive 색을 따뜻한 주황톤으로 잡아 도시 가로등 느낌. shininess는 바다 specular 강조.
    const earthMat = new THREE.MeshPhongMaterial({
      map: dayMap,
      normalMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      specularMap: specMap,
      specular: new THREE.Color(0x9aaab8),
      shininess: 90,
      emissiveMap: lightsMap,
      emissive: new THREE.Color(0xffd29a),
      emissiveIntensity: 1.6,
    });
    const earth = new THREE.Mesh(earthGeo, earthMat);

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

    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(5, 1, 3);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    const BASE_SPIN = 0.0009;
    const ZOOM_DURATION = 1100;
    const START_CAM_Z = 4.0;
    const END_CAM_Z = 1.04;

    let spinSpeed = BASE_SPIN;
    let cloudSpinSpeed = BASE_SPIN * 1.18;
    let zooming = false;
    let zoomStart = 0;
    let zoomCb: (() => void) | null = null;

    apiRef.current = {
      triggerZoom: (cb) => {
        if (zooming) return;
        zooming = true;
        zoomStart = performance.now();
        zoomCb = cb;
      },
    };

    let raf = 0;
    const loop = (now: number) => {
      if (zooming) {
        const t = Math.min(1, (now - zoomStart) / ZOOM_DURATION);
        const eased = t * t * t * t; // ease-in-quart — 후반 가속
        spinSpeed = BASE_SPIN + eased * 0.13;
        cloudSpinSpeed = spinSpeed * 1.18;
        camera.position.z = START_CAM_Z - (START_CAM_Z - END_CAM_Z) * eased;
        if (t >= 1 && zoomCb) {
          zoomCb();
          zoomCb = null;
        }
      }
      earth.rotation.y += spinSpeed;
      clouds.rotation.y += cloudSpinSpeed;
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
      earthMat.dispose();
      cloudMat.dispose();
      atmoMat.dispose();
      starMat.dispose();
      dayMap.dispose();
      specMap.dispose();
      normalMap.dispose();
      cloudMap.dispose();
      lightsMap.dispose();
    };
  }, [size]);

  return (
    <div
      ref={mountRef}
      className={className}
      onClick={onClick}
      style={{ width: size, height: size, cursor: onClick ? 'pointer' : 'default' }}
    />
  );
});

export default Earth3D;
