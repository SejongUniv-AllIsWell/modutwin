import { expect, test, type Page } from '@playwright/test';

const mockApi = async (page: Page, authenticated: boolean) => {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/api/auth/me') && method === 'GET') {
      if (!authenticated) {
        return json({ detail: 'Unauthorized' }, 401);
      }
      return json({
        id: 'smoke-user',
        name: 'Smoke User',
        email: 'smoke@example.com',
        role: 'user',
      });
    }

    if (url.includes('/api/buildings?has_output=true') && method === 'GET') {
      return json([]);
    }

    const floorsMatch = url.match(/\/api\/buildings\/([^/]+)\/floors/);
    if (floorsMatch && method === 'GET') {
      return json([]);
    }

    if (url.includes('/api/auth/login') && method === 'GET') {
      return json({ url: '/' });
    }

    return json({ detail: 'Not mocked in smoke test' }, 404);
  });
};

test('login route renders and redirects without crashing', async ({ page }) => {
  await mockApi(page, false);
  await page.goto('/login');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('ModuTwin')).toBeVisible();
  await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
});

test('explore route shows Kakao key fallback state without backend', async ({ page }) => {
  await mockApi(page, true);
  await page.goto('/explore');
  await expect(page.getByPlaceholder('건물 검색...')).toBeVisible();
  await expect(page.getByText('카카오맵 API 키가 설정되지 않았습니다')).toBeVisible();
});

test('viewer and upload route shells render', async ({ page }) => {
  await mockApi(page, true);

  await page.goto('/viewer');
  await expect(page.getByText('파일을 업로드하세요')).toBeVisible();
  await expect(page.getByText('업로드', { exact: true }).first()).toBeVisible();

  await page.goto('/upload');
  await expect(page.getByRole('heading', { name: '업로드' })).toBeVisible();
  await expect(page.getByRole('button', { name: '건물 둘러보기로 이동' })).toBeVisible();
});
