export const canViewProcessed = image => image?.render_mode === 'overlay' || image?.render_mode === 'legacy_bitmap';
export const isOverlay = image => image?.render_mode === 'overlay';

// Legacy records can still be labelled from their stored subboxes without
// baking another bitmap or declaring the image overlay-ready.
export function canRenderAnnotations(image, teeth = image?.teeth || []) {
  return isOverlay(image) || (image?.render_mode === 'legacy_bitmap'
    && teeth.some(tooth => (tooth.subboxes || []).some(subbox => {
      const box = subbox.bbox;
      return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
        && box[2] > 0 && box[3] > 0;
    })));
}
export function imageApiUrl(path) {
  const base = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '').replace(/\/api$/, '');
  return new URL(`${base}/api/${path.replace(/^\//, '')}`, window.location.origin).href;
}
export const displayImageUrl = (image, mode) => mode === 'processed' && image?.render_mode === 'legacy_bitmap'
  ? image.url_processed : image?.url;

export function imageProxyUrl(url, revision = 1, apiBase = import.meta.env.VITE_API_URL || '') {
  if (!url) return url;
  const parsed = new URL(url, 'http://placeholder');
  let path = parsed.pathname;
  const proxyIndex = path.indexOf('/api/images/proxy/');
  if (proxyIndex >= 0) path = path.slice(proxyIndex + '/api/images/proxy/'.length);
  else path = path.replace(/^\/[^/]+\//, '');
  const base = apiBase.replace(/\/$/, '').replace(/\/api$/, '');
  return `${base}/api/images/proxy/${path}?v=${encodeURIComponent(revision)}`;
}

export function withImageUrls(image) {
  return { ...image, url: imageProxyUrl(image.url, image.image_revision),
    url_processed: imageProxyUrl(image.url_processed, image.processed_at || 1) };
}
