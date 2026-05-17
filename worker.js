const CONFIG_TTL = 604800;

const FREE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const AUTO_CLEAN_THRESHOLD_BYTES = 9 * 1024 * 1024 * 1024;
const AUTO_CLEAN_TARGET_BYTES = 1 * 1024 * 1024 * 1024;

const INVALID_PATH_REGEX = /(?:\.\.|[\x00-\x1F\x7F])/;

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const IMAGE_KEY_REGEX = /^[a-f0-9]{12}\.(jpg|jpeg|png|webp|gif|avif)$/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/') {
        if (!(await isAuthed(request, env))) {
          return html(loginPage(), 200);
        }

        return html(uploadPage(), 200);
      }

      if (pathname === '/login' && request.method === 'POST') {
        return handleLogin(request, env);
      }

      if (pathname === '/logout') {
        return new Response('', {
          status: 302,
          headers: {
            Location: '/',
            'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
          },
        });
      }

      if (pathname === '/upload' && request.method === 'POST') {
        if (!(await isAuthed(request, env))) {
          return json({ success: false, error: 'Unauthorized' }, 401);
        }

        return handleUpload(request, env, ctx);
      }

      if (pathname === '/api/recent' && request.method === 'GET') {
        if (!(await isAuthed(request, env))) {
          return json({ success: false, error: 'Unauthorized' }, 401);
        }

        return handleRecent(request, env);
      }

      if (pathname === '/api/storage' && request.method === 'GET') {
        if (!(await isAuthed(request, env))) {
          return json({ success: false, error: 'Unauthorized' }, 401);
        }

        return handleStorage(request, env);
      }

      if (pathname === '/cleanup' && request.method === 'POST') {
        if (!(await isAuthed(request, env))) {
          return json({ success: false, error: 'Unauthorized' }, 401);
        }

        return handleCleanup(request, env, ctx);
      }

      if (pathname === '/delete' && request.method === 'POST') {
        if (!(await isAuthed(request, env))) {
          return json({ success: false, error: 'Unauthorized' }, 401);
        }

        return handleDelete(request, env, ctx);
      }

      if (pathname.startsWith('/thumb/') && request.method === 'GET') {
        if (!(await isAuthed(request, env))) {
          return new Response('Unauthorized', { status: 401 });
        }

        return handleThumb(request, env, ctx);
      }

      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      return handleImageRequest(request, env, ctx);
    } catch (e) {
      console.log(e);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

async function handleLogin(request, env) {
  const form = await request.formData();
  const password = String(form.get('password') || '');

  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return html('Worker 未配置 ADMIN_PASSWORD 或 SESSION_SECRET', 500);
  }

  if (password !== env.ADMIN_PASSWORD) {
    return html(loginPage('密码错误'), 401);
  }

  const token = await makeSessionToken(env);

  return new Response('', {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
    },
  });
}

async function isAuthed(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);

  if (!match) return false;

  const current = match[1];
  const expected = await makeSessionToken(env);

  return current === expected;
}

async function makeSessionToken(env) {
  const text = `${env.ADMIN_PASSWORD}:${env.SESSION_SECRET}`;
  return sha256(text);
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);

  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function handleUpload(request, env, ctx) {
  const form = await request.formData();
  const file = form.get('file');

  if (!file || typeof file === 'string') {
    return json({ success: false, error: '没有收到文件' }, 400);
  }

  if (!IMAGE_TYPES.has(file.type)) {
    return json({
      success: false,
      error: `不支持的图片类型：${file.type || 'unknown'}`,
    }, 400);
  }

  const width = toIntOrNull(form.get('width'));
  const height = toIntOrNull(form.get('height'));
  const keep = String(form.get('keep') || '') === '1' ? 1 : 0;

  const storageBefore = await getStorageUsageFromD1(env);

  let autoCleanup = null;

  if (storageBefore.totalBytes + file.size > AUTO_CLEAN_THRESHOLD_BYTES) {
    autoCleanup = await cleanupOldestImages(env, ctx, AUTO_CLEAN_TARGET_BYTES, request);
  }

  const ext = getExtFromType(file.type);
  const now = new Date().toISOString();

  let key;
  let exists;

  do {
    key = `${randomId12()}.${ext}`;
    exists = await env.BUCKET.head(key);
  } while (exists);

  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: `public, max-age=${CONFIG_TTL}`,
    },
    customMetadata: {
      originalName: file.name || '',
      uploadedAt: now,
      width: width ? String(width) : '',
      height: height ? String(height) : '',
      keep: keep ? '1' : '0',
    },
  });

  const url = new URL(request.url);
  const directUrl = `${url.origin}/${encodeURIComponent(key)}`;

  await env.DB.prepare(`
    INSERT INTO images (
      key,
      url,
      size,
      content_type,
      width,
      height,
      keep,
      original_name,
      uploaded_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    key,
    directUrl,
    file.size,
    file.type,
    width,
    height,
    keep,
    file.name || '',
    now
  ).run();

  const storageAfter = await getStorageUsageFromD1(env);

  return json({
    success: true,
    key,
    url: directUrl,
    type: file.type,
    size: file.size,
    width,
    height,
    keep: keep === 1,
    uploadedAt: now,
    autoCleanup,
    storage: usagePayload(storageAfter),
  });
}

async function handleRecent(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') || 80), 200);

  const { results } = await env.DB.prepare(`
    SELECT
      key,
      size,
      content_type,
      width,
      height,
      keep,
      original_name,
      uploaded_at
    FROM images
    ORDER BY uploaded_at DESC
    LIMIT ?
  `).bind(limit).all();

  const files = results.map((item) => {
    const link = `${url.origin}/${encodeURIComponent(item.key)}`;
    const thumbLink = `${url.origin}/thumb/${encodeURIComponent(item.key)}`;

    return {
      key: item.key,
      url: link,
      thumbUrl: thumbLink,
      size: item.size,
      type: item.content_type,
      uploaded: item.uploaded_at,
      width: item.width || '',
      height: item.height || '',
      keep: Number(item.keep) === 1,
      originalName: item.original_name || '',
    };
  });

  return json({
    success: true,
    files,
  });
}

async function handleStorage(request, env) {
  const usage = await getStorageUsageFromD1(env);

  return json({
    success: true,
    ...usagePayload(usage),
  });
}

async function handleCleanup(request, env, ctx) {
  const data = await request.json().catch(() => null);

  if (!data || typeof data.gib !== 'number') {
    return json({ success: false, error: '参数错误，需要传入 gib 数字' }, 400);
  }

  const gib = Math.max(0.1, Math.min(data.gib, 20));
  const targetBytes = Math.floor(gib * 1024 * 1024 * 1024);

  const result = await cleanupOldestImages(env, ctx, targetBytes, request);
  const usage = await getStorageUsageFromD1(env);

  return json({
    success: true,
    cleanup: result,
    storage: usagePayload(usage),
  });
}

async function handleDelete(request, env, ctx) {
  const data = await request.json().catch(() => null);

  if (!data || typeof data.key !== 'string') {
    return json({ success: false, error: '参数错误' }, 400);
  }

  const key = data.key;

  if (!IMAGE_KEY_REGEX.test(key)) {
    return json({ success: false, error: '非法文件名' }, 400);
  }

  await env.BUCKET.delete(key);

  await env.DB.prepare(`
    DELETE FROM images WHERE key = ?
  `).bind(key).run();

  clearImageCaches(ctx, request, key);

  const usage = await getStorageUsageFromD1(env);

  return json({
    success: true,
    storage: usagePayload(usage),
  });
}

async function cleanupOldestImages(env, ctx, targetBytes, request) {
  let deletedBytes = 0;
  let deletedCount = 0;
  const deleted = [];

  const { results } = await env.DB.prepare(`
    SELECT key, size
    FROM images
    WHERE keep = 0
    ORDER BY uploaded_at ASC
    LIMIT 1000
  `).all();

  const toDelete = [];

  for (const item of results) {
    if (deletedBytes >= targetBytes) break;

    toDelete.push(item);
    deletedBytes += Number(item.size || 0);
  }

  for (const item of toDelete) {
    try {
      await env.BUCKET.delete(item.key);

      await env.DB.prepare(`
        DELETE FROM images WHERE key = ?
      `).bind(item.key).run();

      deletedCount += 1;
      deleted.push(item.key);

      if (request) {
        clearImageCaches(ctx, request, item.key);
      }
    } catch (e) {
      console.log('cleanup delete failed:', item.key, e);
    }
  }

  const protectedRow = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM images
    WHERE keep = 1
  `).first();

  return {
    targetBytes,
    targetText: formatBytes(targetBytes),
    deletedBytes,
    deletedText: formatBytes(deletedBytes),
    deletedCount,
    skippedProtectedCount: Number(protectedRow?.count || 0),
    deleted,
  };
}

async function getStorageUsageFromD1(env) {
  const row = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(size), 0) AS totalBytes,
      COUNT(*) AS imageCount,
      COALESCE(SUM(CASE WHEN keep = 1 THEN size ELSE 0 END), 0) AS protectedBytes,
      SUM(CASE WHEN keep = 1 THEN 1 ELSE 0 END) AS protectedCount
    FROM images
  `).first();

  return {
    totalBytes: Number(row?.totalBytes || 0),
    imageBytes: Number(row?.totalBytes || 0),
    imageCount: Number(row?.imageCount || 0),
    objectCount: Number(row?.imageCount || 0),
    protectedBytes: Number(row?.protectedBytes || 0),
    protectedCount: Number(row?.protectedCount || 0),
  };
}

function usagePayload(usage) {
  const totalBytes = usage.totalBytes || 0;

  return {
    totalBytes,
    imageBytes: usage.imageBytes || totalBytes,
    objectCount: usage.objectCount || 0,
    imageCount: usage.imageCount || 0,
    protectedBytes: usage.protectedBytes || 0,
    protectedCount: usage.protectedCount || 0,

    freeLimitBytes: FREE_LIMIT_BYTES,
    autoCleanThresholdBytes: AUTO_CLEAN_THRESHOLD_BYTES,
    percent: FREE_LIMIT_BYTES > 0 ? totalBytes / FREE_LIMIT_BYTES : 0,

    totalText: formatBytes(totalBytes),
    imageText: formatBytes(usage.imageBytes || totalBytes),
    protectedText: formatBytes(usage.protectedBytes || 0),
    freeLimitText: formatBytes(FREE_LIMIT_BYTES),
    thresholdText: formatBytes(AUTO_CLEAN_THRESHOLD_BYTES),
  };
}

async function handleThumb(request, env, ctx) {
  const url = new URL(request.url);
  const rawKey = url.pathname.slice('/thumb/'.length);

  let key;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  if (!IMAGE_KEY_REGEX.test(key)) {
    return new Response('Bad Request', { status: 400 });
  }

  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set('w', '160');
  cacheUrl.searchParams.set('h', '120');

  const cacheRequest = new Request(cacheUrl.toString(), request);
  const cache = caches.default;

  const cached = await cache.match(cacheRequest);
  if (cached) {
    const res = new Response(cached.body, cached);
    res.headers.set('X-Cache-Status', 'HIT');
    return res;
  }

  const sourceUrl = new URL(`/${encodeURIComponent(key)}`, url.origin);

  const imageResponse = await fetch(sourceUrl.toString(), {
    cf: {
      image: {
        width: 160,
        height: 120,
        fit: 'cover',
        quality: 70,
        format: 'webp',
        anim: false,
      },
    },
  });

  if (!imageResponse.ok) {
    return imageResponse;
  }

  const headers = new Headers(imageResponse.headers);
  headers.set('Cache-Control', `public, max-age=${CONFIG_TTL}`);
  headers.set('X-Cache-Status', 'MISS');

  const finalResponse = new Response(imageResponse.body, {
    status: imageResponse.status,
    headers,
  });

  ctx.waitUntil(cache.put(cacheRequest, finalResponse.clone()));

  return finalResponse;
}

async function handleImageRequest(request, env, ctx) {
  const url = new URL(request.url);
  const rawPath = url.pathname.slice(1);

  let key;
  try {
    key = decodeURIComponent(rawPath);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  if (!key || INVALID_PATH_REGEX.test(key)) {
    return new Response('Bad Request', { status: 400 });
  }

  const cacheUrl = new URL(url.origin + url.pathname);
  const cacheRequest = new Request(cacheUrl.toString(), request);

  const cache = caches.default;
  const cachedResponse = await cache.match(cacheRequest);

  if (cachedResponse) {
    const response = new Response(cachedResponse.body, cachedResponse);
    response.headers.set('X-Cache-Status', 'HIT');
    return response;
  }

  const object = await env.BUCKET.get(key);

  if (!object) {
    return new Response('Not Found', { status: 404 });
  }

  const headers = new Headers();

  const contentType =
    object.httpMetadata?.contentType ||
    guessContentType(key) ||
    'application/octet-stream';

  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', `public, max-age=${CONFIG_TTL}`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Cache-Status', 'MISS');

  if (object.httpEtag) {
    headers.set('ETag', object.httpEtag);
  }

  const response = new Response(object.body, {
    status: 200,
    headers,
  });

  ctx.waitUntil(cache.put(cacheRequest, response.clone()));

  return response;
}

function clearImageCaches(ctx, request, key) {
  const url = new URL(request.url);
  const imageUrl = `${url.origin}/${encodeURIComponent(key)}`;
  const thumbUrl = `${url.origin}/thumb/${encodeURIComponent(key)}?w=160&h=120`;

  ctx.waitUntil(Promise.all([
    caches.default.delete(new Request(imageUrl, { method: 'GET' })),
    caches.default.delete(new Request(thumbUrl, { method: 'GET' })),
  ]));
}

function randomId12() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);

  return [...bytes]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toIntOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function getExtFromType(type) {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  if (type === 'image/avif') return 'avif';

  return 'bin';
}

function guessContentType(key) {
  const lower = key.toLowerCase();

  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.avif')) return 'image/avif';

  return null;
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);

  if (n < 1024) return `${n} B`;

  const kib = n / 1024;
  if (kib < 1024) return `${kib.toFixed(2)} KiB`;

  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(2)} MiB`;

  const gib = mib / 1024;
  return `${gib.toFixed(2)} GiB`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}

function loginPage(error = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>图片上传登录</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f8fafc;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .box {
      width: min(380px, calc(100vw - 32px));
      background: white;
      padding: 36px;
      border-radius: 20px;
      box-shadow: 0 20px 25px -5px rgba(0,0,0,0.05), 0 10px 10px -5px rgba(0,0,0,0.02);
      border: 1px solid #f1f5f9;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #0f172a;
      margin: 0 0 8px;
      text-align: center;
    }
    .subtitle {
      font-size: 14px;
      color: #64748b;
      text-align: center;
      margin-bottom: 28px;
    }
    input, button {
      width: 100%;
      box-sizing: border-box;
      font-size: 15px;
      padding: 12px 16px;
      border-radius: 12px;
      transition: all 0.2s;
    }
    input {
      border: 1px solid #e2e8f0;
      margin-bottom: 16px;
      background: #f8fafc;
      color: #0f172a;
    }
    input:focus {
      outline: none;
      border-color: #0f172a;
      background: white;
      box-shadow: 0 0 0 4px rgba(15, 23, 42, 0.08);
    }
    button {
      border: 0;
      background: #0f172a;
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover {
      background: #1e293b;
    }
    button:active {
      transform: scale(0.98);
    }
    .error {
      background: #fef2f2;
      color: #ef4444;
      border: 1px solid #fee2e2;
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 14px;
      margin-bottom: 16px;
      text-align: center;
    }
  </style>
</head>
<body>
  <form class="box" method="post" action="/login">
    <h1>图床后台管理</h1>
    <div class="subtitle">输入密码以继续</div>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <input name="password" type="password" placeholder="请输入密码" autofocus>
    <button type="submit">登录</button>
  </form>
</body>
</html>`;
}

function uploadPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>控制台 - R2图床</title>
  <style>
    body {
      margin: 0;
      background: #f8fafc;
      color: #0f172a;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .wrap {
      max-width: 1140px;
      margin: 40px auto;
      padding: 0 24px;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 32px;
    }
    .brand h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.025em;
      background: linear-gradient(to right, #0f172a, #334155);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .brand a {
      color: #64748b;
      font-size: 14px;
      text-decoration: none;
      display: inline-block;
      margin-top: 4px;
      transition: color 0.2s;
    }
    .brand a:hover {
      color: #ef4444;
    }
    
    /* 核心悬浮折叠设计 */
    .storage {
      width: 320px;
      background: white;
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);
      border: 1px solid #e2e8f0;
      transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      z-index: 100;
    }
    .storage-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .storage-top strong {
      font-size: 13px;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    #storageText {
      font-size: 14px;
      font-weight: 700;
      color: #0f172a;
    }
    .bar {
      height: 8px;
      background: #f1f5f9;
      border-radius: 999px;
      overflow: hidden;
    }
    .bar-inner {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #1e293b, #475569);
      border-radius: 999px;
      transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    /* 默认隐藏的清理面板内容 */
    .storage-actions-wrapper {
      max-height: 0;
      opacity: 0;
      visibility: hidden;
      overflow: hidden;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .storage:hover {
      box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);
      border-color: #cbd5e1;
      transform: translateY(-2px);
    }
    /* 鼠标移入展开 */
    .storage:hover .storage-actions-wrapper {
      max-height: 220px;
      opacity: 1;
      visibility: visible;
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px dashed #e2e8f0;
    }
    .storage-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    .storage-actions input {
      width: 85px;
      padding: 10px;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      outline: none;
      font-size: 14px;
      font-weight: 600;
      text-align: center;
    }
    .storage-actions input:focus {
      border-color: #0f172a;
    }
    .storage-actions button {
      flex: 1;
      border: 0;
      background: #0f172a;
      color: white;
      border-radius: 10px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: background 0.2s;
    }
    .storage-actions button:hover {
      background: #1e293b;
    }

    /* 现代药丸滑动标签页 */
    .tabs {
      display: inline-flex;
      background: #e2e8f0;
      padding: 4px;
      border-radius: 999px;
      margin-bottom: 24px;
      gap: 2px;
    }
    .tab {
      border: 0;
      background: transparent;
      padding: 8px 20px;
      border-radius: 999px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      color: #64748b;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .tab.active {
      background: white;
      color: #0f172a;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03);
    }
    
    .card {
      background: white;
      border-radius: 20px;
      padding: 32px;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.04), 0 4px 6px -4px rgba(0,0,0,0.02);
      border: 1px solid #f1f5f9;
    }
    
    /* 现代化高拟真拖拽区 */
    .drop {
      border: 2px dashed #cbd5e1;
      border-radius: 16px;
      padding: 56px 24px;
      text-align: center;
      color: #64748b;
      background: #f8fafc;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: pointer;
    }
    .drop:hover {
      border-color: #94a3b8;
      background: #f1f5f9;
    }
    .drop.drag {
      border-color: #0f172a;
      background: #f1f5f9;
      color: #0f172a;
      transform: scale(0.99);
    }
    .drop strong {
      color: #0f172a;
      font-size: 16px;
      display: block;
      margin-bottom: 6px;
    }
    input[type=file] {
      display: none;
    }
    .btn {
      display: inline-block;
      border: 0;
      background: #0f172a;
      color: white;
      padding: 10px 20px;
      border-radius: 10px;
      cursor: pointer;
      margin-top: 18px;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      transition: all 0.2s;
    }
    .btn:hover {
      background: #1e293b;
    }
    .btn:active, .smallbtn:active {
      transform: scale(0.95);
    }
    .keep-line {
      margin-top: 20px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: #334155;
      font-size: 14px;
      user-select: none;
      cursor: pointer;
    }
    .keep-line input {
      width: 16px;
      height: 16px;
      accent-color: #0f172a;
    }
    
    /* 上传结果样式优化 */
    .result {
      margin-top: 28px;
      display: none;
      border-top: 1px dashed #e2e8f0;
      padding-top: 24px;
    }
    .result-title {
      font-size: 14px;
      font-weight: 600;
      color: #334155;
      margin-bottom: 8px;
    }
    .linkrow {
      display: flex;
      gap: 12px;
      margin-top: 8px;
    }
    .linkrow input {
      flex: 1;
      padding: 12px 16px;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      background: #f8fafc;
      font-family: monospace;
      font-size: 14px;
      color: #334155;
    }
    .linkrow button {
      border: 0;
      background: #0f172a;
      color: white;
      padding: 0 20px;
      border-radius: 12px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      transition: background 0.2s;
    }
    .linkrow button:hover {
      background: #1e293b;
    }
    .preview {
      max-width: 100%;
      max-height: 320px;
      border-radius: 14px;
      display: block;
      margin-top: 20px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      border: 1px solid #e2e8f0;
    }
    .muted {
      color: #64748b;
      font-size: 13px;
      line-height: 1.5;
    }
    .hidden {
      display: none !important;
    }
    
    /* 列表项的网格化及流畅动效 */
    .list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .row {
      display: grid;
      grid-template-columns: 88px 120px 1fr 88px 80px 80px;
      gap: 16px;
      align-items: center;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 12px;
      background: #fff;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .row:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 20px -8px rgba(0,0,0,0.08);
      border-color: #cbd5e1;
    }
    .thumb {
      width: 88px;
      height: 66px;
      object-fit: cover;
      border-radius: 10px;
      background: #f1f5f9;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .thumb:hover {
      opacity: 0.9;
    }
    .res {
      font-size: 14px;
      font-weight: 600;
      color: #334155;
      white-space: nowrap;
    }
    .time {
      font-size: 14px;
      color: #64748b;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      font-size: 12px;
      font-weight: 600;
      padding: 6px 10px;
      border-radius: 999px;
      background: #f1f5f9;
      color: #64748b;
      text-align: center;
    }
    .badge.keep {
      background: #dcfce7;
      color: #15803d;
    }
    .smallbtn {
      border: 0;
      padding: 10px 14px;
      border-radius: 10px;
      cursor: pointer;
      background: #f1f5f9;
      color: #0f172a;
      font-size: 13px;
      font-weight: 600;
      transition: all 0.2s;
    }
    .smallbtn:hover {
      background: #e2e8f0;
    }
    .smallbtn.danger {
      background: #fee2e2;
      color: #ef4444;
    }
    .smallbtn.danger:hover {
      background: #fca5a5;
      color: #991b1b;
    }
    .smallbtn:disabled,
    .storage-actions button:disabled {
      opacity: .5;
      cursor: not-allowed;
    }

    @media (max-width: 760px) {
      .top {
        flex-direction: column;
        align-items: flex-start;
      }
      .storage {
        width: 100%;
        box-sizing: border-box;
      }
      .row {
        grid-template-columns: 80px 1fr;
        gap: 8px 14px;
      }
      .thumb {
        width: 80px;
        height: 60px;
        grid-row: span 5;
      }
      .res, .time {
        white-space: normal;
      }
      .badge {
        grid-column: 2;
        justify-self: start;
      }
      .smallbtn {
        grid-column: 2;
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <h1>图床控制台</h1>
        <a href="/logout">退出</a>
      </div>

      <div class="storage">
        <div class="storage-top">
          <strong>R2 存储容量使用率</strong>
          <span id="storageText">加载中...</span>
        </div>
        <div class="bar">
          <div id="storageBar" class="bar-inner"></div>
        </div>
        
        <!-- 容器包装：悬浮时才会滑出 -->
        <div class="storage-actions-wrapper">
          <div class="muted" id="storageSub">加载统计数据中...</div>
          <div class="storage-actions">
            <input id="cleanupGib" type="number" min="0.1" step="0.1" value="1">
            <button id="cleanupBtn">清理最老的 GiB</button>
          </div>
        </div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="upload">上传图片</button>
      <button class="tab" data-tab="recent">最近上传</button>
    </div>

    <section id="upload" class="card">
      <div id="drop" class="drop">
        <div><strong>点击选择图片文件</strong>或者将文件拖拽到此区域</div>
        <div class="muted">支持直接使用 Ctrl + V 粘贴剪贴板内的图像</div>
        <label class="btn">
          浏览本地文件
          <input id="file" type="file" accept="image/*">
        </label>
        <br>
        <label class="keep-line">
          <input id="keep" type="checkbox">
          <span>该图片极其重要，永不自动清理</span>
        </label>
      </div>

      <div id="result" class="result">
        <div class="result-title">🎉 上传成功，图片直链：</div>
        <div class="linkrow">
          <input id="link" readonly>
          <button id="copy">一键复制</button>
        </div>
        <div id="uploadNote" class="muted" style="margin-top:12px; font-weight: 500;"></div>
        <img id="preview" class="preview">
      </div>
    </section>

    <section id="recent" class="card hidden">
      <div id="recentList" class="list"></div>
    </section>
  </div>

  <script>
    const tabs = document.querySelectorAll('.tab');
    const uploadSec = document.getElementById('upload');
    const recentSec = document.getElementById('recent');
    const drop = document.getElementById('drop');
    const fileInput = document.getElementById('file');
    const keepInput = document.getElementById('keep');
    const result = document.getElementById('result');
    const linkInput = document.getElementById('link');
    const copyBtn = document.getElementById('copy');
    const preview = document.getElementById('preview');
    const uploadNote = document.getElementById('uploadNote');
    const recentList = document.getElementById('recentList');

    const storageText = document.getElementById('storageText');
    const storageSub = document.getElementById('storageSub');
    const storageBar = document.getElementById('storageBar');
    const cleanupGib = document.getElementById('cleanupGib');
    const cleanupBtn = document.getElementById('cleanupBtn');

    let currentTab = 'upload';

    loadStorage();

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const name = tab.dataset.tab;
        currentTab = name;

        uploadSec.classList.toggle('hidden', name !== 'upload');
        recentSec.classList.toggle('hidden', name !== 'recent');

        if (name === 'recent') {
          loadRecent();
        }
      });
    });

    cleanupBtn.addEventListener('click', async () => {
      const gib = Number(cleanupGib.value || 1);

      if (!Number.isFinite(gib) || gib <= 0) {
        alert('请输入要清理的 GiB 数量');
        return;
      }

      if (!confirm('确定清理最老的约 ' + gib + ' GiB 图片吗？带“永不清理”的图片会被跳过。')) {
        return;
      }

      cleanupBtn.disabled = true;
      cleanupBtn.textContent = '清理中...';

      const res = await fetch('/cleanup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ gib }),
      });

      const data = await res.json();

      cleanupBtn.disabled = false;
      cleanupBtn.textContent = '清理最老的 GiB';

      if (!data.success) {
        alert(data.error || '清理失败');
        return;
      }

      applyStorage(data.storage);

      alert('已清理 ' + data.cleanup.deletedText + '，删除 ' + data.cleanup.deletedCount + ' 张。');

      if (currentTab === 'recent') {
        loadRecent();
      }
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (file) uploadFile(file);
    });

    drop.addEventListener('dragover', e => {
      e.preventDefault();
      drop.classList.add('drag');
    });

    drop.addEventListener('dragleave', () => {
      drop.classList.remove('drag');
    });

    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('drag');

      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    });

    document.addEventListener('paste', e => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();

          if (file) {
            uploadFile(file);
            break;
          }
        }
      }
    });

    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(linkInput.value);
      copyBtn.textContent = '已复制';
      setTimeout(() => copyBtn.textContent = '一键复制', 1000);
    });

    async function getImageSize(file) {
      try {
        const bitmap = await createImageBitmap(file);
        const width = bitmap.width;
        const height = bitmap.height;
        bitmap.close && bitmap.close();

        return { width, height };
      } catch (e) {
        return { width: '', height: '' };
      }
    }

    async function uploadFile(file) {
      if (!file.type.startsWith('image/')) {
        alert('请选择图片文件');
        return;
      }

      const size = await getImageSize(file);

      const fd = new FormData();
      fd.append('file', file, file.name || 'paste.png');
      fd.append('width', size.width);
      fd.append('height', size.height);
      fd.append('keep', keepInput.checked ? '1' : '0');

      result.style.display = 'block';
      linkInput.value = '上传中...';
      uploadNote.textContent = '';
      preview.removeAttribute('src');

      const res = await fetch('/upload', {
        method: 'POST',
        body: fd,
      });

      const data = await res.json();
      
      if (!data.success) {
        linkInput.value = '';
        alert(data.error || '上传失败');
        return;
      }

      linkInput.value = data.url;
      preview.src = data.url;

      uploadNote.textContent = data.keep
        ? '🔒 这张图片已标记为永不自动清理。'
        : '🔓 这张图片在容量超限时可被自动清理。';

      if (data.autoCleanup && data.autoCleanup.deletedCount > 0) {
        uploadNote.textContent += ' 本次上传前自动清理了 ' + data.autoCleanup.deletedText + '。';
      }

      if (data.storage) {
        applyStorage(data.storage);
      }
    }

    async function loadStorage() {
      storageText.textContent = '...';

      const res = await fetch('/api/storage');
      const data = await res.json();

      if (!data.success) {
        storageText.textContent = '获取失败';
        return;
      }

      applyStorage(data);
    }

    function applyStorage(data) {
      const percent = Math.min(100, Math.max(0, data.percent * 100));

      storageText.textContent = data.totalText + ' / ' + data.freeLimitText;
      storageBar.style.width = percent.toFixed(1) + '%';

      storageSub.textContent =
        '共 ' + data.imageCount + ' 张图片，其中保护 ' + data.protectedCount +
        ' 张（占 ' + data.protectedText +
        '）。当总容量超过 ' + data.thresholdText + ' 时将触发自动清理逻辑。';
    }

    async function loadRecent() {
      recentList.innerHTML = '<div class="muted">正在读取最近上传记录...</div>';

      const res = await fetch('/api/recent?limit=80');
      const data = await res.json();

      if (!data.success) {
        recentList.innerHTML = '<div class="muted">数据加载失败</div>';
        return;
      }

      if (!data.files.length) {
        recentList.innerHTML = '<div class="muted">暂无任何图片上传记录</div>';
        return;
      }

      recentList.innerHTML = '';

      for (const file of data.files) {
        const row = document.createElement('div');
        row.className = 'row';

        const img = document.createElement('img');
        img.className = 'thumb';
        img.src = file.thumbUrl || file.url;
        img.loading = 'lazy';
        img.onclick = () => {
          window.open(file.url, '_blank');
        };

        const resDiv = document.createElement('div');
        resDiv.className = 'res';

        if (file.width && file.height) {
          resDiv.textContent = file.width + ' × ' + file.height;
        } else {
          resDiv.textContent = '分辨率未知';
        }

        const timeDiv = document.createElement('div');
        timeDiv.className = 'time';
        timeDiv.textContent = formatTime(file.uploaded);

        const badge = document.createElement('div');
        badge.className = file.keep ? 'badge keep' : 'badge';
        badge.textContent = file.keep ? '永不清理' : '可自动清理';

        const copy = document.createElement('button');
        copy.className = 'smallbtn';
        copy.textContent = '复制直链';
        copy.onclick = async () => {
          await navigator.clipboard.writeText(file.url);
          copy.textContent = '已复制';
          setTimeout(() => copy.textContent = '复制直链', 1000);
        };

        const del = document.createElement('button');
        del.className = 'smallbtn danger';
        del.textContent = '彻底删除';
        del.onclick = async () => {
          if (!confirm('确定彻底从存储中删除这张图片吗？')) return;

          del.disabled = true;
          del.textContent = '删除中';

          const res = await fetch('/delete', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              key: file.key,
            }),
          });

          const data = await res.json();

          if (!data.success) {
            del.disabled = false;
            del.textContent = '彻底删除';
            alert(data.error || '删除失败');
            return;
          }

          row.remove();

          if (data.storage) {
            applyStorage(data.storage);
          }
        };

        row.appendChild(img);
        row.appendChild(resDiv);
        row.appendChild(timeDiv);
        row.appendChild(badge);
        row.appendChild(copy);
        row.appendChild(del);

        recentList.appendChild(row);
      }
    }

    function formatTime(value) {
      if (!value) return '时间未知';

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return String(value);
      }

      return date.toLocaleString();
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}