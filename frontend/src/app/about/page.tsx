'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

interface Step {
  numeral: string;
  title: string;
  body: string;
}

const PIPELINE_STEPS: Step[] = [
  {
    numeral: 'i.',
    title: '촬영 · 영상 업로드',
    body:
      '휴대폰이나 카메라로 60초 분량의 영상을 찍어 올립니다. '
      + '균일한 속도와 충분한 시점 변화가 있을수록 결과물의 품질이 좋아집니다.',
  },
  {
    numeral: 'ii.',
    title: '프레임 추출 · SfM',
    body:
      '서버가 영상에서 이미지를 추출해 카메라 위치와 특징점을 추정합니다. '
      + '여기서 만들어진 카메라 포즈와 점들이 3DGS 학습의 초기값이 됩니다.',
  },
  {
    numeral: 'iii.',
    title: '3DGS 학습',
    body:
      '점들을 수백만 개의 가우시안으로 확장하고, 각 가우시안의 위치·색·크기·불투명도를 '
      + '원본에 맞춰 최적화합니다. 학습이 완성되면, 공간을 자유롭게 돌아다닐 수 있는 디지털 트윈이 됩니다.',
  },
  {
    numeral: 'iv.',
    title: '정렬 · 게시',
    body:
      '학습된 데이터를 건물 도면·층에 맞춰 정렬하고, 고정합니다. '
      + '검수가 끝나면 공개 저장소의 일부가 되어 누구나 둘러볼 수 있습니다.',
  },
];

interface GaussianFeature {
  eyebrow: string;
  title: string;
  body: string;
}

const GAUSSIAN_FEATURES: GaussianFeature[] = [
  {
    eyebrow: '실시간으로 움직이는 공간',
    title: '영상처럼 부드럽게 볼 수 있다',
    body:
      '미리 렌더링된 영상이 아니라, 사용자가 원하는 방향으로 즉시 화면이 바뀝니다. '
      + '마우스로 돌려보거나 이동해도 끊김 없이 자연스럽게 움직여 실제 공간 안에 들어온 듯한 느낌을 줍니다.',
  },
  {
    eyebrow: '사진 같은 결과',
    title: '반사와 질감까지 자연스럽게 표현',
    body:
      '유리의 반사, 금속의 빛, 머리카락이나 나뭇잎 같은 복잡한 부분도 자연스럽게 표현됩니다. '
      + '단순한 3D 그래픽보다 훨씬 실제 사진에 가까운 분위기를 만들 수 있습니다.',
  },
  {
    eyebrow: '편집 가능한 표현',
    title: '필요한 부분만 자유롭게 편집',
    body:
      '공간 전체를 다시 만들지 않아도 원하는 부분만 수정하거나 합칠 수 있습니다. '
      + '게임, 전시, 쇼핑몰, 가상 공간 제작 등 다양한 분야에서 빠르게 활용할 수 있습니다.',
  },
];

interface PlatformPoint {
  title: string;
  body: string;
}

const PLATFORM_POINTS: PlatformPoint[] = [
  {
    title: '함께 만드는 실내 지도',
    body:
      '한 사람이 모든 실내를 다 찍을 수는 없습니다. ModuTwin은 누구나 자신의 공간을 올리고, '
      + '그 조각들이 모여 하나의 거대한 실내 지도를 완성해가는 플랫폼입니다.',
  },
  {
    title: '현실 공간처럼 이어지는 구조',
    body:
      '모든 공간은 건물과 층 단위로 정리되며, 각각의 공간이 자연스럽게 연결됩니다. '
      + '복도에서 방으로, 로비에서 다른 구역으로 실제 건물처럼 이동할 수 있습니다.',
  },
  {
    title: '설치 없이 바로 체험',
    body:
      '별도 프로그램을 설치하지 않아도 웹브라우저에서 바로 공간을 둘러볼 수 있습니다. '
      + '원하는 공간을 자유롭게 이동하며 실제 장소처럼 탐색할 수 있습니다.',
  },
  {
    title: '모두의 기여',
    body:
      '모든 공간에는 소중한 기여자가 기록됩니다. '
      + '내가 공유한 공간이 다른 사람들과 함께 모여 큰 지도를 만듭니다.',
  },
];

export default function AboutPage() {
  const router = useRouter();
  const { user, login } = useAuth();

  const goExplore = useCallback(() => router.push('/explore'), [router]);

  const requireLoginThenExplore = useCallback(() => {
    if (user) goExplore();
    else login();
  }, [user, login, goExplore]);

  return (
    <div className="about min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <style jsx global>{`
        .about {
          font-family: var(--font-noto-sans-kr), 'Noto Sans KR', Helvetica, 'Helvetica Neue', Arial, sans-serif;
          -webkit-font-smoothing: antialiased;
          text-rendering: optimizeLegibility;
        }
      `}</style>

      <header
        className="sticky top-0 z-10 border-b backdrop-blur-sm"
        style={{ background: 'var(--bg)', borderColor: 'var(--rule)' }}
      >
        <div className="max-w-[1200px] mx-auto px-7 h-14 flex items-center justify-between">
          <a
            href="/"
            className="modutwin-logo text-xl"
            style={{ color: 'var(--ink)' }}
          >
            m<span className="modutwin-logo-dot">o</span>d<span className="modutwin-logo-dot">u</span>twin
          </a>
          <nav className="flex items-center gap-6 text-[13.5px]">
            <a
              href="/about"
              className="rounded-sm px-2.5 py-1.5"
              style={{ color: 'var(--accent)', background: 'var(--accent-soft)', fontWeight: 600 }}
            >
              About
            </a>
            <button
              type="button"
              onClick={goExplore}
              className="rounded-sm px-2.5 py-1.5 hover:bg-sky-400/10 active:bg-sky-400/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400/60"
              style={{ color: 'var(--ink-2)' }}
            >
              Browse
            </button>
            <button
              type="button"
              onClick={requireLoginThenExplore}
              className="rounded-sm px-2.5 py-1.5 hover:bg-sky-400/10 active:bg-sky-400/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400/60"
              style={{ color: 'var(--ink-2)' }}
            >
              Contribute
            </button>
            {user ? (
              <span
                className="px-3 py-1.5 rounded-sm border text-[13.5px]"
                style={{ borderColor: 'var(--rule)', color: 'var(--ink-2)' }}
              >
                {user.name}
              </span>
            ) : (
              <button
                type="button"
                onClick={login}
                className="px-3 py-1.5 rounded-sm hover:bg-sky-400/10"
                style={{ color: 'var(--ink)' }}
              >
                Sign in
              </button>
            )}
          </nav>
        </div>
      </header>

      <section
        className="border-b"
        style={{ borderColor: 'var(--rule)', padding: '72px 0 56px' }}
      >
        <div className="max-w-[1200px] mx-auto px-7">
          <span
            className="mono text-[11.5px] uppercase block mb-6"
            style={{ color: 'var(--muted)', letterSpacing: 0 }}
          >
            About · ModuTwin
          </span>
          <h1
            className="font-medium leading-[1.02] mb-6 text-balance"
            style={{ fontSize: 'clamp(40px, 5.4vw, 58px)', color: 'var(--ink)' }}
          >
            영상 한 편을 걸어 다닐 수 있는 공간으로
          </h1>
          <p
            className="text-[17px] leading-[1.7]"
            style={{ color: 'var(--ink-2)' }}
          >
            ModuTwin 은 3D Gaussian Splatting 을 기반으로 한 크라우드소싱 실내 디지털 트윈 플랫폼입니다.
            누구나 자신이 다니는 공간의 영상을 올리면, 그 장면을 3D 로 복원해
            지도 위에 붙입니다. 이 페이지는 그 기술이 어떤 것이고, 우리가 어떤 플랫폼을 만들고 있으며,
            영상이 어떤 단계를 거쳐 디지털 트윈이 되는지에 대한 짧은 안내입니다.
          </p>
        </div>
      </section>

      <section id="gaussian-splatting" style={{ paddingTop: 56, paddingBottom: 10 }}>
        <div
          className="max-w-[1200px] mx-auto px-7"
          style={{
            background: 'var(--paper)',
            border: '1px solid var(--rule)',
            borderRadius: 8,
            padding: 'clamp(28px, 5vw, 56px) clamp(20px, 4vw, 48px)',
          }}
        >
          <div className="flex items-baseline justify-between gap-5 mb-9 flex-wrap">
            <span
            className="mono text-[11.5px] uppercase"
            style={{ color: 'var(--muted)', letterSpacing: 0 }}
            >
              01 · 3D Gaussian Splatting
            </span>
            <h2
              className="font-semibold m-0 text-balance"
              style={{ fontSize: 'clamp(28px, 3vw, 40px)', color: 'var(--ink)' }}
            >
              수백만 개의 작은 빛 덩어리
            </h2>
          </div>

          <p className="m-0 mb-10" style={{ color: 'var(--ink-2)' }}>
            3D Gaussian Splatting (3DGS) 은 여러 장의 사진만으로 어떤 공간이든 그대로 옮겨오는
            새로운 기술입니다. 흔히 보던 3D 모델은 작은 삼각형 조각을 이어 붙여 만들지만,
            3DGS 는 공간 안에 수백만 개의 작은 빛 덩어리를 띄워 공간을 그려냅니다.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
            {GAUSSIAN_FEATURES.map((f) => (
              <div
                key={f.title}
                className="p-7"
                style={{ background: 'var(--paper)', border: '1px solid var(--rule-soft)', borderRadius: 8 }}
              >
                <div
                  className="text-[14px] mb-3"
                  style={{ color: 'var(--muted)' }}
                >
                  {f.eyebrow}
                </div>
                <h3
                  className="font-semibold m-0 mb-3"
                  style={{ fontSize: 22, letterSpacing: 0 }}
                >
                  {f.title}
                </h3>
                <p className="m-0" style={{ color: 'var(--ink-2)' }}>
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="platform" style={{ paddingTop: 10, paddingBottom: 10 }}>
        <div
          className="max-w-[1200px] mx-auto px-7"
          style={{
            background: 'var(--paper)',
            border: '1px solid var(--rule)',
            borderRadius: 8,
            padding: 'clamp(28px, 5vw, 56px) clamp(20px, 4vw, 48px)',
          }}
        >
          <div className="flex items-baseline justify-between gap-5 mb-9 flex-wrap">
            <span
              className="mono text-[11.5px] uppercase"
              style={{ color: 'var(--muted)', letterSpacing: 0 }}
            >
              02 · The platform
            </span>
            <h2
              className="font-semibold m-0 text-balance"
              style={{ fontSize: 'clamp(28px, 3vw, 40px)', color: 'var(--ink)' }}
            >
              실내를 위한, 모두가 함께 쓰는 지도
            </h2>
          </div>

          <p
            className="m-0 mb-10"
            style={{ color: 'var(--ink-2)' }}
          >
            외부는 위성과 스트리트뷰가 다 채웠지만, 학교 강의실, 동네 카페, 박물관 내부 같은 실내는
            여전히 비어 있습니다. ModuTwin은 그 빈자리를 사용자가 직접 채우는 플랫폼입니다.
            휴대폰 한 대로도 한 모듈을 채울 수 있고, 올린 영상은 디지털 트윈의 일부가 됩니다.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {PLATFORM_POINTS.map((p) => (
              <div
                key={p.title}
                className="p-7"
                style={{ background: 'var(--paper)', border: '1px solid var(--rule-soft)', borderRadius: 8 }}
              >
                <h3
                  className="font-semibold m-0 mb-3"
                  style={{ fontSize: 22, letterSpacing: 0 }}
                >
                  {p.title}
                </h3>
                <p className="m-0" style={{ color: 'var(--ink-2)' }}>
                  {p.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pipeline" style={{ paddingTop: 10, paddingBottom: 56 }}>
        <div
          className="max-w-[1200px] mx-auto px-7"
          style={{
            background: 'var(--paper)',
            border: '1px solid var(--rule)',
            borderRadius: 8,
            padding: 'clamp(28px, 5vw, 56px) clamp(20px, 4vw, 48px)',
          }}
        >
          <div className="flex items-baseline justify-between gap-5 mb-9 flex-wrap">
            <span
              className="mono text-[11.5px] uppercase"
              style={{ color: 'var(--muted)', letterSpacing: 0 }}
            >
              03 · From video to digital twin
            </span>
            <h2
              className="font-semibold m-0 text-balance"
              style={{ fontSize: 'clamp(28px, 3vw, 40px)', color: 'var(--ink)' }}
            >
              영상이 디지털 트윈이 되기까지
            </h2>
          </div>

          <ol className="list-none p-0 m-0 grid gap-3">
            {PIPELINE_STEPS.map((s) => (
              <li
                key={s.numeral}
                className="grid items-start gap-6 py-6 px-7"
                style={{
                  background: 'var(--paper)',
                  border: '1px solid var(--rule-soft)',
                  borderRadius: 8,
                  gridTemplateColumns: 'auto 1fr',
                }}
              >
                <span
                  className="mono leading-none font-semibold"
                  style={{
                    fontSize: 44,
                    color: 'var(--accent)',
                    letterSpacing: 0,
                    minWidth: 56,
                  }}
                >
                  {s.numeral}
                </span>
                <div className="min-w-0">
                  <h3
                    className="font-semibold m-0 mb-3"
                    style={{ fontSize: 22, letterSpacing: 0 }}
                  >
                    {s.title}
                  </h3>
                  <p
                    className="m-0"
                    style={{ color: 'var(--ink-2)' }}
                  >
                    {s.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-9 flex gap-3 flex-wrap items-center">
            <button
              type="button"
              onClick={requireLoginThenExplore}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-sm text-[13.5px] border"
              style={{
                background: 'var(--accent)',
                color: '#04131f',
                borderColor: 'var(--accent)',
              }}
            >
              지금 기여하기 →
            </button>
            <button
              type="button"
              onClick={goExplore}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-sm text-[13.5px] border"
              style={{
                background: 'var(--accent-soft)',
                color: 'var(--ink)',
                borderColor: 'rgba(56, 189, 248, 0.38)',
              }}
            >
              지도에서 둘러보기
            </button>
          </div>
        </div>
      </section>

      <footer style={{ padding: '36px 0 48px', color: 'var(--muted)' }}>
        <div className="max-w-[1200px] mx-auto px-7">
          <div
            className="flex justify-between gap-5 flex-wrap mono text-[14px] uppercase"
            style={{ color: 'var(--ink)', letterSpacing: 0 }}
          >
            <span>© 2024–2026 ModuTwin</span>
            <span>public beta · build {process.env.NEXT_PUBLIC_BUILD_TAG ?? '2026.05.21'}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
