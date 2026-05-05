const BASEMAP_KEY_PREFIX = 'basemap_corners_v1_';
const BASEMAP_URL_KEY_PREFIX = 'basemap_ply_url_v1_';

export function loadBasemapJson(uploadId: string): string {
  try {
    const raw = localStorage.getItem(BASEMAP_KEY_PREFIX + uploadId);
    return raw ?? '';
  } catch {
    return '';
  }
}

export function saveBasemapJson(uploadId: string, json: string) {
  try {
    localStorage.setItem(BASEMAP_KEY_PREFIX + uploadId, json);
  } catch {
    /* ignore */
  }
}

export function loadBasemapUrl(uploadId: string): string {
  try {
    return localStorage.getItem(BASEMAP_URL_KEY_PREFIX + uploadId) ?? '';
  } catch {
    return '';
  }
}

export function saveBasemapUrl(uploadId: string, url: string) {
  try {
    localStorage.setItem(BASEMAP_URL_KEY_PREFIX + uploadId, url);
  } catch {
    /* ignore */
  }
}
