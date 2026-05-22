# Frontend Pages

Last updated: 2026-05-22 (removed orphan routes: `/multi-viewer`, `/admin/basemaps`, `/door-select/[scene_id]`, `/login` stub)

This document lists the current Next.js App Router pages under
`frontend/src/app`. Routes are derived from `page.tsx` files.

## Page Routes

| Route | File | Purpose |
| --- | --- | --- |
| `/` | `frontend/src/app/page.tsx` | Landing page for ModuTwin, including product explanation, Start now, Browse, Contribute, and globe animation. |
| `/about` | `frontend/src/app/about/page.tsx` | About page explaining 3D Gaussian Splatting, the ModuTwin platform, and the video-to-digital-twin pipeline. Linked from the landing nav. |
| `/explore` | `frontend/src/app/explore/page.tsx` | Kakao map based building exploration page. Anonymous browsing is allowed. |
| `/buildings/[name]` | `frontend/src/app/buildings/[name]/page.tsx` | Building overview page with floor list, floor overview images, and registration entry points. |
| `/buildings/[name]/floors/[floorNumber]` | `frontend/src/app/buildings/[name]/floors/[floorNumber]/page.tsx` | Floor detail viewer for basemap/module viewing and registration entry points. |
| `/viewer` | `frontend/src/app/viewer/page.tsx` | Single splat viewer and editing/alignment surface for uploads or existing scenes. |
| `/upload` | `frontend/src/app/upload/page.tsx` | Upload page for context-driven basemap/module uploads. |
| `/dashboard` | `frontend/src/app/dashboard/page.tsx` | User/admin dashboard entry page. |
| `/login/callback` | `frontend/src/app/login/callback/page.tsx` | OAuth callback handler page. |

## Shared Page Shell

| File | Role |
| --- | --- |
| `frontend/src/app/layout.tsx` | Root layout. Wraps pages with `AuthProvider`, `Navbar`, and `AppShell`. |
| `frontend/src/components/dashboard/Navbar.tsx` | Global dashboard navigation. Hidden on `/` and `/about` (they render their own header). |
| `frontend/src/components/dashboard/AppShell.tsx` | Applies top padding for pages that use the global navbar; leaves `/` and `/about` unpadded since they render their own header. |
