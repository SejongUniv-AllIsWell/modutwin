'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { floorLabel } from '@/lib/format/floor';
import Earth3D from '@/components/landing/Earth3D';

interface StepsCard {
  numeral: string;
  title: string;
  body: string;
}

interface StepsSectionDef {
  slug: string;
  eyebrow: string;
  title: string;
  variant: 'steps';
  cards: StepsCard[];
}

interface ListSectionDef {
  slug: string;
  eyebrow: string;
  title: string;
  variant: 'list';
  cardCount: number;
  entryLeading: 'rank' | 'date';
}

type SectionDef = StepsSectionDef | ListSectionDef;

const SECTIONS: SectionDef[] = [
  {
    slug: 'participate',
    eyebrow: '01 · How to participate',
    title: '기록을 추가하는 방법',
    variant: 'steps',
    cards: [
      {
        numeral: 'i.',
        title: '영상 업로드',
        body:
          '휴대폰이나 드론 영상 한 편을 올리면 서버가 프레임 추출 · SfM · 3DGS 학습을 ' +
          '자동으로 진행합니다. 학습이 끝나는 즉시 아틀라스의 일부가 됩니다.',
      },
      {
        numeral: 'ii.',
        title: '포인트 클라우드 제출',
        body:
          '이미 학습한 splat 이 있다면 .ply / .sog / .splat 파일을 직접 업로드하세요. ' +
          '지오태그만 붙이면 즉시 둘러볼 수 있습니다.',
      },
      {
        numeral: 'iii.',
        title: '이미지 + SfM 기여',
        body:
          '직접 찍은 사진과 COLMAP / OpenSfM 결과물을 가져오세요. 그 지점부터 재구성을 ' +
          '이어 받고, 결과 씬에 기여자를 함께 표기합니다.',
      },
    ],
  },
  {
    slug: 'community',
    eyebrow: '02 · Community favourites',
    title: 'Most liked',
    variant: 'list',
    cardCount: 5,
    entryLeading: 'rank',
  },
  {
    slug: 'wiki',
    eyebrow: '03 · From the wiki',
    title: 'Recently edited',
    variant: 'list',
    cardCount: 5,
    entryLeading: 'date',
  },
];

interface LandingStats {
  buildings: number;
  modules: number;
  contributors: number;
}

interface LandingEntry {
  building_id: string;
  building_name: string;
  floor_id: string;
  floor_number: number;
  module_id: string;
  module_name: string;
  uploaded_at: string;
  star_count: number;
}

interface LandingFeed {
  recent: LandingEntry[];
  popular: LandingEntry[];
}

// IntersectionObserver 기반 스크롤 페이드인. 화면에 들어올 때 opacity 0 → 1 + translateY 해제.
// once-only — 한 번 보이면 disconnect.
function ScrollReveal({
  children,
  delay = 0,
  yOffset = 50,
  duration = 750,
}: {
  children: ReactNode;
  delay?: number;
  yOffset?: number;
  duration?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -80px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : `translateY(${yOffset}px)`,
        transition: `opacity ${duration}ms cubic-bezier(0.2, 0.7, 0.2, 1) ${delay}ms, transform ${duration}ms cubic-bezier(0.2, 0.7, 0.2, 1) ${delay}ms`,
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </div>
  );
}

export default function LandingPage() {
  const router = useRouter();
  const { user, login } = useAuth();
  const globeWrapRef = useRef<HTMLDivElement | null>(null);
  const fadeRef = useRef<HTMLDivElement | null>(null);
  const isZoomingRef = useRef(false);
  const [stats, setStats] = useState<LandingStats | null>(null);
  const [feed, setFeed] = useState<LandingFeed | null>(null);

  const goExplore = useCallback(() => router.push('/explore'), [router]);

  const requireLoginThenExplore = useCallback(() => {
    if (user) {
      goExplore();
    } else {
      login();
    }
  }, [user, login, goExplore]);

  const zoomAndGo = useCallback(() => {
    const wrap = globeWrapRef.current;
    const fade = fadeRef.current;
    if (!wrap || !fade) {
      goExplore();
      return;
    }
    if (isZoomingRef.current) return;
    isZoomingRef.current = true;

    const rect = wrap.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cxScreen = rect.left + rect.width / 2;
    const cyScreen = rect.top + rect.height / 2;
    const dx = Math.max(cxScreen, vw - cxScreen);
    const dy = Math.max(cyScreen, vh - cyScreen);
    const maxDist = Math.hypot(dx, dy);
    const scale = (maxDist * 2.2) / rect.width;
    const tx = vw / 2 - cxScreen;
    const ty = vh / 2 - cyScreen;

    window.scrollTo({ top: 0, behavior: 'smooth' });

    wrap.style.transition = 'transform 900ms cubic-bezier(0.7, 0, 0.3, 1)';
    wrap.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;

    window.setTimeout(() => fade.classList.add('opacity-100'), 350);
    window.setTimeout(() => {
      router.push('/explore');
    }, 900);
  }, [goExplore, router]);

  useEffect(() => {
    let disposed = false;
    api
      .get<LandingStats>('/landing/stats')
      .then((s) => {
        if (disposed) return;
        setStats(s);
      })
      .catch(() => {
        // 엔드포인트 실패 시 hero meta 는 — 로 남겨둠
      });
    api
      .get<LandingFeed>('/landing/feed')
      .then((f) => {
        if (disposed) return;
        setFeed(f);
      })
      .catch(() => {
        // §02/§03 리스트는 빈 상태로 남겨둠
      });
    return () => {
      disposed = true;
    };
  }, []);

  const formatEntryDate = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()} · ${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getDate()).padStart(2, '0')}`;
  };

  return (
    <div className="landing min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <style jsx global>{`
        .landing {
          font-family: var(--font-noto-sans-kr), 'Noto Sans KR', Helvetica, 'Helvetica Neue', Arial, sans-serif;
          -webkit-font-smoothing: antialiased;
          text-rendering: optimizeLegibility;
        }
        .landing-fade {
          position: fixed;
          inset: 0;
          background: var(--bg);
          opacity: 0;
          pointer-events: none;
          z-index: 9999;
          transition: opacity 500ms ease;
        }
        .landing-fade.opacity-100 {
          opacity: 1;
        }
        .globe-wrap {
          position: relative;
          width: min(418px, calc(100vw - 56px));
          height: min(418px, calc(100vw - 56px));
          cursor: pointer;
          transition: transform 900ms cubic-bezier(0.7, 0, 0.3, 1);
          transform-origin: center;
          will-change: transform;
        }
        .globe-wrap > div,
        .globe-wrap canvas {
          width: 100% !important;
          height: 100% !important;
          display: block;
        }
      `}</style>

      <header
        className="sticky top-0 z-10 border-b backdrop-blur-sm"
        style={{ background: 'var(--bg)', borderColor: 'var(--rule)' }}
      >
        <div className="max-w-[1200px] mx-auto px-7 h-14 flex items-center justify-between">
          <a
            href="/"
            className="flex items-baseline gap-[10px] no-underline serif font-semibold text-xl"
            style={{ color: 'var(--ink)', letterSpacing: 0 }}
          >
            modu
            <span
              className="inline-block w-[6px] h-[6px] -translate-y-[3px]"
              style={{ background: 'var(--ink)' }}
            />
            twin
          </a>
          <nav className="flex items-center gap-6 text-[13.5px]">
            <button
              type="button"
              onClick={() => router.push('/about')}
              className="hover:underline underline-offset-4"
              style={{ color: 'var(--ink-2)' }}
            >
              About
            </button>
            <button
              type="button"
              onClick={goExplore}
              className="hover:underline underline-offset-4"
              style={{ color: 'var(--ink-2)' }}
            >
              Browse
            </button>
            <button
              type="button"
              onClick={requireLoginThenExplore}
              className="hover:underline underline-offset-4"
              style={{ color: 'var(--ink-2)' }}
            >
              Contribute
            </button>
            {user ? (
              <button
                type="button"
                onClick={() => router.push('/dashboard')}
                className="px-3 py-1.5 rounded-sm border text-[13.5px] hover:bg-[var(--bg-soft)]"
                style={{ borderColor: 'var(--rule)', color: 'var(--ink-2)' }}
              >
                {user.name}
              </button>
            ) : (
              <button
                type="button"
                onClick={login}
                className="px-3 py-1.5 rounded-sm hover:bg-[var(--bg-soft)]"
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
        style={{ borderColor: 'var(--rule)', padding: '64px 0 56px' }}
      >
        <div className="max-w-[1200px] mx-auto px-7 grid grid-cols-1 md:grid-cols-[1.15fr_0.85fr] gap-14 items-center">
          <div>
            <h1
              className="font-medium leading-[1.02] mb-6 text-balance"
              style={{ fontSize: 'clamp(40px, 5.4vw, 58px)', color: 'var(--ink)' }}
            >
              The collaborative wiki for<br />
              <em className="serif italic">3D Gaussian Splatting</em>
            </h1>
            <p
              className="text-[17px] leading-[1.6] mb-7 max-w-[650px]"
              style={{ color: 'var(--ink-2)' }}
            >
              ModuTwin 은 누구나 영상 한 편으로 건물 내부를 3D 로 복원해 지도에 올릴 수 있는,
              크라우드소싱 기반 실내 디지털 트윈 플랫폼입니다. 영상을 올리고, 지도 위에 두면,
              공개 아틀라스의 일부가 됩니다.
            </p>
            <div className="flex gap-3 flex-wrap items-center mb-7">
              <button
                type="button"
                onClick={zoomAndGo}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-sm text-[13.5px] border"
                style={{
                  background: 'var(--accent)',
                  color: '#04131f',
                  borderColor: 'var(--accent)',
                }}
              >
                Start now →
              </button>
            </div>
            <div
              className="flex gap-6 items-center mono text-[11.5px] tracking-wider"
              style={{ color: 'var(--muted)', letterSpacing: '0.06em' }}
            >
              <div>
                <b
                  className="mono font-semibold text-[14px]"
                  style={{ color: 'var(--accent)', letterSpacing: 0 }}
                >
                  {stats ? stats.buildings.toLocaleString() : '—'}
                </b>{' '}
                건물
              </div>
              <div>
                <b
                  className="mono font-semibold text-[14px]"
                  style={{ color: 'var(--accent)', letterSpacing: 0 }}
                >
                  {stats ? stats.modules.toLocaleString() : '—'}
                </b>{' '}
                모듈
              </div>
              <div>
                <b
                  className="mono font-semibold text-[14px]"
                  style={{ color: 'var(--accent)', letterSpacing: 0 }}
                >
                  {stats ? stats.contributors.toLocaleString() : '—'}
                </b>{' '}
                기여자
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center relative">
            <div ref={globeWrapRef} className="globe-wrap" onClick={zoomAndGo}>
              <Earth3D size={418} />
            </div>
          </div>
        </div>
      </section>

      {SECTIONS.map((section, sectionIdx) => {
        return (
          <ScrollReveal key={section.slug}>
            <section
              id={section.slug}
              style={{
                paddingTop: sectionIdx === 0 ? 56 : 10,
                paddingBottom: sectionIdx === SECTIONS.length - 1 ? 56 : 10,
              }}
            >
              <div
                className="max-w-[1200px] mx-auto px-7"
                style={{
                  background: 'var(--paper)',
                  border: '1px solid var(--rule)',
                  borderRadius: 8,
                  padding: 'clamp(28px, 5vw, 56px) clamp(20px, 4vw, 48px)',
                }}
              >
                <div className="flex items-baseline justify-between gap-5 mb-9">
                  <span
                    className="mono text-[11.5px] uppercase tracking-[0.14em]"
                    style={{ color: 'var(--muted)' }}
                  >
                    {section.eyebrow}
                  </span>
                  <h2
                    className="serif font-medium m-0 text-balance min-h-[1.2em]"
                    style={{
                      fontSize: 'clamp(28px, 3vw, 40px)',
                      color: 'var(--ink)',
                    }}
                  >
                    {section.title}
                  </h2>
                </div>

                {section.variant === 'steps' ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
                    {section.cards.map((card, i) => (
                      <ScrollReveal key={i} delay={150 + i * 110} yOffset={30}>
                        <div
                          className="p-7 flex flex-col gap-3.5"
                          style={{
                            background: 'var(--paper)',
                            border: '1px solid var(--rule-soft)',
                            borderRadius: 8,
                          }}
                        >
                          <div
                            className="serif italic text-[56px] leading-none"
                            style={{ color: 'var(--accent)', letterSpacing: 0 }}
                          >
                            {card.numeral}
                          </div>
                          <h3
                            className="serif font-medium m-0 min-h-[1.2em]"
                            style={{ fontSize: 24, letterSpacing: 0 }}
                          >
                            {card.title}
                          </h3>
                          <p
                            className="m-0 min-h-[1.4em]"
                            style={{ color: 'var(--ink-2)' }}
                          >
                            {card.body}
                          </p>
                        </div>
                      </ScrollReveal>
                    ))}
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {Array.from({ length: section.cardCount }).map((_, i) => {
                      const entries =
                        section.entryLeading === 'rank' ? feed?.popular : feed?.recent;
                      const entry = entries?.[i];
                      const leading =
                        section.entryLeading === 'rank'
                          ? `#${i + 1}`
                          : formatEntryDate(entry?.uploaded_at);
                      const showTrailing = section.entryLeading === 'rank';
                      return (
                        <ScrollReveal key={i} delay={150 + i * 90} yOffset={24}>
                          <div
                            onClick={() => {
                              if (!entry) return;
                              router.push(
                                `/buildings/${entry.building_id}/floors/${entry.floor_number}`,
                              );
                            }}
                            className={`grid items-start gap-[22px] py-[18px] px-[22px] transition ${entry ? 'cursor-pointer hover:bg-[var(--bg-soft)]' : ''
                              }`}
                            style={{
                              background: 'var(--paper)',
                              border: '1px solid var(--rule-soft)',
                              borderRadius: 8,
                              gridTemplateColumns: showTrailing ? 'auto 1fr auto' : 'auto 1fr',
                            }}
                          >
                            <span
                              className="mono text-[11.5px] whitespace-nowrap pt-[5px]"
                              style={{ color: 'var(--muted)', letterSpacing: '0.06em' }}
                            >
                              {leading}
                            </span>
                            <div className="min-w-0">
                              <div
                                className="serif font-medium min-h-[1.2em] truncate"
                                style={{
                                  fontSize: 19,
                                  color: 'var(--ink)',
                                  letterSpacing: 0,
                                }}
                              >
                                {entry?.building_name ?? ''}
                              </div>
                              <div
                                className="mt-1 min-h-[1.4em] text-[14px] truncate"
                                style={{ color: 'var(--ink-2)' }}
                              >
                                {entry
                                  ? `${floorLabel(entry.floor_number)} · ${entry.module_name}`
                                  : ''}
                              </div>
                            </div>
                            {showTrailing && (
                              <span
                                className="mono text-[11px] inline-flex items-center gap-1 pt-[5px]"
                                style={{ color: 'var(--ink)', letterSpacing: '0.02em' }}
                              >
                                <svg
                                  viewBox="0 0 16 16"
                                  width="12"
                                  height="12"
                                  aria-hidden="true"
                                  style={{ color: 'var(--accent)' }}
                                >
                                  <path
                                    fill="currentColor"
                                    d="M8 1.2 9.93 5.46l4.67.48-3.5 3.16.99 4.6L8 11.3l-4.09 2.4.99-4.6L1.4 5.94l4.67-.48L8 1.2z"
                                  />
                                </svg>
                                {entry?.star_count ?? 0}
                              </span>
                            )}
                          </div>
                        </ScrollReveal>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </ScrollReveal>
        );
      })}

      <footer style={{ padding: '36px 0 48px', color: 'var(--muted)' }}>
        <div className="max-w-[1200px] mx-auto px-7">
          <div
            className="flex justify-between gap-5 flex-wrap mono text-[14px] uppercase tracking-[0.08em]"
            style={{ color: 'var(--ink)' }}
          >
            <span>© 2024–2026 ModuTwin</span>
            <span>public beta · build {process.env.NEXT_PUBLIC_BUILD_TAG ?? '2026.05.21'}</span>
          </div>
        </div>
      </footer>

      <div ref={fadeRef} className="landing-fade" />
    </div>
  );
}
