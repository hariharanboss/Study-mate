import { HTML_TEMPLATE } from './html.js';
import { SW_CONTENT } from './sw-content.js';
import DEFAULT_FILE_SYSTEM from './virtual-fs.default.js';

const FS_INDEX_KEY = 'personal_lms_fs_index_v6';
const SUGGESTIONS_KEY = 'personal_lms_suggestions_v2';
const STATS_KEY = 'personal_lms_stats_v3';
const BROADCASTS_KEY = 'current_notes_broadcasts_v2';
const ACTIVE_BROADCAST_KEY = 'current_notes_active_broadcast_v2';
const SUBSCRIBERS_COUNT_KEY = 'current_notes_subscribers_v2';
const RATE_LIMIT_PREFIX = 'rl_v4_';
const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB Free Tier

// Helper: Standard security headers applied to all responses
function getSecurityHeaders(contentType = 'application/json;charset=UTF-8') {
  return {
    'content-type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

// Helper: JSON response with security headers
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: getSecurityHeaders('application/json;charset=UTF-8')
  });
}

// Crypto: Secure HMAC-SHA256 Token Generation & Verification
async function createHmacToken(secretKey, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = JSON.stringify(payload);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const b64Data = btoa(unescape(encodeURIComponent(data)));
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${b64Data}.${b64Sig}`;
}

async function verifyHmacToken(secretKey, token) {
  try {
    const [b64Data, b64Sig] = token.split('.');
    if (!b64Data || !b64Sig) return null;

    const dataStr = decodeURIComponent(escape(atob(b64Data)));
    const payload = JSON.parse(dataStr);

    if (!payload.exp || Date.now() > payload.exp) {
      return null;
    }

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secretKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigBytes = Uint8Array.from(atob(b64Sig), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(dataStr));
    return isValid ? payload : null;
  } catch (err) {
    return null;
  }
}

// Auth Middleware: Verify Admin token
async function checkAdminAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.substring(7).trim();
  const configured = (env.ADMIN_PASSWORD || '').trim() || 'admin';
  const payload = await verifyHmacToken(configured, token);
  return !!(payload && payload.role === 'admin');
}

// In-memory / KV rate limiter
async function isRateLimited(env, key, maxAttempts = 5, windowSeconds = 600) {
  if (!env.FILES_DB) return false;
  // Bypass rate limiting for localhost during local development
  if (key.includes('127.0.0.1') || key.includes('::1') || key.includes('unknown') || env.ENVIRONMENT === 'development') {
    return false;
  }
  try {
    const fullKey = `${RATE_LIMIT_PREFIX}${key}`;
    const raw = await env.FILES_DB.get(fullKey);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= maxAttempts) return true;
    await env.FILES_DB.put(fullKey, (count + 1).toString(), { expirationTtl: windowSeconds });
    return false;
  } catch (e) {
    return false;
  }
}

async function checkRateLimit(env, key, maxAttempts = 10) {
  if (!env.FILES_DB) return false;
  if (key.includes('127.0.0.1') || key.includes('::1') || key.includes('unknown') || env.ENVIRONMENT === 'development') {
    return false;
  }
  try {
    const fullKey = `${RATE_LIMIT_PREFIX}${key}`;
    const raw = await env.FILES_DB.get(fullKey);
    const count = raw ? parseInt(raw, 10) : 0;
    return count >= maxAttempts;
  } catch (e) {
    return false;
  }
}

async function recordFailedAttempt(env, key, windowSeconds = 300) {
  if (!env.FILES_DB) return;
  try {
    const fullKey = `${RATE_LIMIT_PREFIX}${key}`;
    const raw = await env.FILES_DB.get(fullKey);
    const count = raw ? parseInt(raw, 10) : 0;
    await env.FILES_DB.put(fullKey, (count + 1).toString(), { expirationTtl: windowSeconds });
  } catch (e) {
    // Non-critical
  }
}

async function resetRateLimit(env, key) {
  if (!env.FILES_DB) return;
  try {
    const fullKey = `${RATE_LIMIT_PREFIX}${key}`;
    await env.FILES_DB.delete(fullKey);
  } catch (e) {
    // Non-critical
  }
}

// Helper: Format bytes to human readable string
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper: Track Analytics Events
async function trackEvent(env, eventType, detailKey = null) {
  if (!env.FILES_DB) return;
  try {
    let stats = { totalVisits: 0, totalDownloads: 0, dailyVisits: {}, fileDownloads: {} };
    const raw = await env.FILES_DB.get(STATS_KEY);
    if (raw) stats = JSON.parse(raw);

    const today = new Date().toISOString().split('T')[0];

    if (eventType === 'visit') {
      stats.totalVisits = (stats.totalVisits || 0) + 1;
      if (!stats.dailyVisits) stats.dailyVisits = {};
      stats.dailyVisits[today] = (stats.dailyVisits[today] || 0) + 1;
    } else if (eventType === 'download') {
      stats.totalDownloads = (stats.totalDownloads || 0) + 1;
      if (detailKey) {
        if (!stats.fileDownloads) stats.fileDownloads = {};
        stats.fileDownloads[detailKey] = (stats.fileDownloads[detailKey] || 0) + 1;
      }
    }

    await env.FILES_DB.put(STATS_KEY, JSON.stringify(stats));
  } catch (e) {
    console.error('trackEvent failed:', e);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: getSecurityHeaders()
      });
    }

    // 1. Static Assets & Manifest
    if (url.pathname === '/sw.js') {
      return new Response(SW_CONTENT, {
        headers: getSecurityHeaders('application/javascript;charset=UTF-8')
      });
    }

    // Favicon handler (Lucide Bookshelf SVG)
    if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
      const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#1d4ed8"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><g fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(4,4)"><path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/></g></svg>`;
      return new Response(faviconSvg, {
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }

    if (url.pathname === '/manifest.json') {
      const manifest = {
        name: "Study Mate",
        short_name: "StudyMate",
        description: "StudyMate: of the students, by the students, for the students. Free notes, question papers and video playlists, all in one place.",
        start_url: "/",
        display: "standalone",
        background_color: "#08090d",
        theme_color: "#3b82f6",
        icons: [
          {
            src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%233b82f6'/%3E%3Cstop offset='100%25' stop-color='%231d4ed8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='8' fill='url(%23g)'/%3E%3Cg fill='none' stroke='%23ffffff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' transform='translate(4,4)'%3E%3Cpath d='m16 6 4 14'/%3E%3Cpath d='M12 6v14'/%3E%3Cpath d='M8 8v12'/%3E%3Cpath d='M4 4v16'/%3E%3C/g%3E%3C/svg%3E",
            sizes: "192x192 512x512",
            type: "image/svg+xml"
          }
        ]
      };
      return new Response(JSON.stringify(manifest), {
        headers: getSecurityHeaders('application/manifest+json;charset=UTF-8')
      });
    }

    // 2. Public Config API
    if (url.pathname === '/api/config' && method === 'GET') {
      return jsonResponse({
        success: true,
        defaultTheme: env.DEFAULT_THEME || 'dark',
        hasWeb3Forms: Boolean(env.WEB3FORMS_ACCESS_KEY),
        hasR2: Boolean(env.FILES_BUCKET)
      });
    }

    // 3. File System - Read Tree (Public)
    if (url.pathname === '/api/fs' && method === 'GET') {
      try {
        let tree = null;
        if (env.FILES_DB) {
          const cached = await env.FILES_DB.get(FS_INDEX_KEY);
          if (cached) {
            tree = JSON.parse(cached);
          }
        }
        if (!tree) {
          tree = DEFAULT_FILE_SYSTEM;
          if (env.FILES_DB) {
            await env.FILES_DB.put(FS_INDEX_KEY, JSON.stringify(tree));
          }
        } else if (tree.name === 'Department Academic Hub' || tree.name === 'current notes' || !tree.name) {
          tree.name = 'Study Mate';
          tree.description = 'StudyMate: of the students, by the students, for the students. Free notes, question papers and video playlists, all in one place.';
          if (tree.stickyNotes && tree.stickyNotes[0] && (tree.stickyNotes[0].id === 'note_welcome' || tree.stickyNotes[0].title.includes('Welcome') || tree.stickyNotes[0].title.includes('Zero Arrears'))) {
            tree.stickyNotes[0].title = '🎯 Welcome to Study Mate';
            tree.stickyNotes[0].content = "StudyMate: of the students, by the students, for the students.\n\nFree notes, previous year solved question papers, lab manuals with viva answers, and recommended video playlists, all in one place.\n\n📱 **Tip:** Save this site to your home screen (PWA) to access materials anytime, even offline.\n💡 Have a material to share? Click **Suggest Material** at the top!";
          }
          if (env.FILES_DB) {
            await env.FILES_DB.put(FS_INDEX_KEY, JSON.stringify(tree));
          }
        }
        return jsonResponse({ success: true, tree });
      } catch (err) {
        return jsonResponse({ success: false, error: 'Failed to load file tree', details: err.message }, 500);
      }
    }

    // 4. Admin Auth: Login
    if (url.pathname === '/api/auth/login' && method === 'POST') {
      const rlKey = `auth_${clientIp}`;
      if (await checkRateLimit(env, rlKey, 10)) {
        return jsonResponse({ success: false, error: 'Too many failed login attempts. Please wait 5 minutes.' }, 429);
      }

      try {
        const body = await request.json();
        const entered = (body.password || '').trim();
        const configured = (env.ADMIN_PASSWORD || '').trim() || 'admin';

        if (entered && entered === configured) {
          await resetRateLimit(env, rlKey);
          const token = await createHmacToken(configured, {
            role: 'admin',
            iat: Date.now(),
            exp: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
          });
          return jsonResponse({ success: true, token, role: 'admin' });
        }

        await recordFailedAttempt(env, rlKey, 300);
        return jsonResponse({ success: false, error: 'Invalid admin password' }, 401);
      } catch (e) {
        return jsonResponse({ success: false, error: 'Invalid request payload' }, 400);
      }
    }

    // 5. Admin Auth: Verify Token
    if (url.pathname === '/api/auth/check' && method === 'GET') {
      const isAdmin = await checkAdminAuth(request, env);
      return jsonResponse({ success: isAdmin, role: isAdmin ? 'admin' : 'guest' });
    }

    // 6. File System - Save / Update Tree (Admin Only)
    if (url.pathname === '/api/fs/update' && method === 'POST') {
      const isAdmin = await checkAdminAuth(request, env);
      if (!isAdmin) {
        return jsonResponse({ success: false, error: 'Unauthorized: Admin privileges required' }, 403);
      }

      try {
        const body = await request.json();
        if (!body.tree || typeof body.tree !== 'object') {
          return jsonResponse({ success: false, error: 'Missing or invalid file tree structure' }, 400);
        }

        if (env.FILES_DB) {
          await env.FILES_DB.put(FS_INDEX_KEY, JSON.stringify(body.tree));
        }
        return jsonResponse({ success: true, message: 'File system tree updated successfully' });
      } catch (err) {
        return jsonResponse({ success: false, error: 'Failed to update file system', details: err.message }, 500);
      }
    }

    // 7. Binary File Upload (Admin Only) - Cloudflare R2 with fallback to KV
    if (url.pathname === '/api/files/upload' && method === 'POST') {
      const isAdmin = await checkAdminAuth(request, env);
      if (!isAdmin) {
        return jsonResponse({ success: false, error: 'Unauthorized: Admin privileges required' }, 403);
      }

      try {
        const formData = await request.formData();
        const file = formData.get('file');
        const customName = formData.get('name') || (file ? file.name : 'unnamed_file');

        if (!file) {
          return jsonResponse({ success: false, error: 'No file uploaded' }, 400);
        }

        const fileBytes = await file.arrayBuffer();
        const fileExt = customName.split('.').pop() || '';
        const uniqueKey = `file_${Date.now()}_${Math.random().toString(36).substr(2, 8)}.${fileExt}`;

        if (env.FILES_BUCKET) {
          await env.FILES_BUCKET.put(uniqueKey, fileBytes, {
            httpMetadata: {
              contentType: file.type || 'application/octet-stream',
              contentDisposition: `inline; filename="${encodeURIComponent(customName)}"`
            }
          });
        } else if (env.FILES_DB) {
          if (fileBytes.byteLength > 24 * 1024 * 1024) {
            return jsonResponse({
              success: false,
              error: 'File size exceeds Cloudflare KV 24MB limit. For larger textbooks, please use a Google Drive link.'
            }, 413);
          }
          // Zero-copy direct binary storage in Cloudflare KV with metadata (0ms CPU, zero RAM bloat)
          await env.FILES_DB.put(`blob_${uniqueKey}`, fileBytes, {
            metadata: {
              mimeType: file.type || 'application/octet-stream',
              name: customName
            }
          });
        }

        return jsonResponse({
          success: true,
          file: {
            id: 'item_' + Date.now(),
            name: customName,
            type: 'file',
            fileSize: fileBytes.byteLength,
            mimeType: file.type || 'application/octet-stream',
            storageKey: uniqueKey,
            url: `/api/files/download/${uniqueKey}`,
            createdAt: new Date().toISOString()
          }
        });
      } catch (err) {
        return jsonResponse({ success: false, error: 'File upload failed', details: err.message }, 500);
      }
    }

    // 8. Binary File Download / Stream (Public) - Tracks Downloads & Supports Inline Code Viewing
    if (url.pathname.startsWith('/api/files/download/')) {
      const storageKey = decodeURIComponent(url.pathname.replace('/api/files/download/', ''));
      if (!storageKey) {
        return new Response('File key not specified', { status: 400 });
      }

      // Track download metric
      await trackEvent(env, 'download', storageKey);

      // Helper to detect MIME type and text/code status
      function getFileStreamMime(filename, fallbackMime = 'application/octet-stream') {
        const lower = (filename || '').toLowerCase();
        const ext = lower.includes('.') ? lower.split('.').pop() : '';
        const codeTextExts = [
          'py', 'm', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'java', 'kt', 'kts',
          'js', 'jsx', 'ts', 'tsx', 'html', 'htm', 'css', 'json', 'sql', 'sh',
          'bash', 'ps1', 'bat', 'cmd', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf',
          'txt', 'md', 'markdown', 'csv', 'tsv', 'r', 'rs', 'go', 'cs', 'php', 'swift', 'asm'
        ];
        if (codeTextExts.includes(ext)) {
          return { mime: 'text/plain; charset=utf-8', isInlineCode: true };
        }
        const mimeMap = {
          pdf: 'application/pdf',
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          svg: 'image/svg+xml',
          webp: 'image/webp',
          mp3: 'audio/mpeg',
          wav: 'audio/wav',
          mp4: 'video/mp4',
          webm: 'video/webm',
          doc: 'application/msword',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ppt: 'application/vnd.ms-powerpoint',
          pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          xls: 'application/vnd.ms-excel',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        };
        return { mime: mimeMap[ext] || fallbackMime, isInlineCode: false };
      }

      const isDownloadParam = url.searchParams.get('download') === '1';

      try {
        if (env.FILES_BUCKET) {
          const object = await env.FILES_BUCKET.get(storageKey);
          if (!object) {
            return new Response('File not found in storage', { status: 404 });
          }

          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set('etag', object.httpEtag);
          headers.set('cache-control', 'public, max-age=31536000, immutable');
          headers.set('Access-Control-Allow-Origin', '*');

          const mimeInfo = getFileStreamMime(storageKey, headers.get('content-type') || 'application/octet-stream');
          headers.set('content-type', mimeInfo.mime);

          if (isDownloadParam) {
            headers.set('content-disposition', `attachment; filename="${encodeURIComponent(storageKey)}"`);
          } else {
            headers.set('content-disposition', `inline; filename="${encodeURIComponent(storageKey)}"`);
          }

          return new Response(object.body, { headers });
        }

        if (env.FILES_DB) {
          // 1. Try reading native binary with metadata (high performance, zero CPU overhead)
          const res = await env.FILES_DB.getWithMetadata(`blob_${storageKey}`, { type: 'arrayBuffer' });
          if (res && res.value) {
            const fileName = (res.metadata && res.metadata.name) || storageKey;
            const fileMime = (res.metadata && res.metadata.mimeType) || 'application/octet-stream';
            const mimeInfo = getFileStreamMime(fileName, fileMime);
            const disposition = isDownloadParam ? 'attachment' : 'inline';

            return new Response(res.value, {
              headers: {
                'content-type': mimeInfo.mime,
                'content-disposition': `${disposition}; filename="${encodeURIComponent(fileName)}"`,
                'cache-control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          // 2. Backward compatibility fallback for legacy Base64 JSON strings
          const raw = await env.FILES_DB.get(`blob_${storageKey}`);
          if (!raw) {
            return new Response('File not found in storage', { status: 404 });
          }
          try {
            const blobMeta = JSON.parse(raw);
            const binaryStr = atob(blobMeta.data);
            const len = binaryStr.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }

            const mimeInfo = getFileStreamMime(blobMeta.name || storageKey, blobMeta.mimeType || 'application/octet-stream');
            const disposition = isDownloadParam ? 'attachment' : 'inline';

            return new Response(bytes, {
              headers: {
                'content-type': mimeInfo.mime,
                'content-disposition': `${disposition}; filename="${encodeURIComponent(blobMeta.name || storageKey)}"`,
                'cache-control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (e) {
            return new Response('File not found or corrupted', { status: 404 });
          }
        }

        return new Response('No storage backend configured', { status: 500 });
      } catch (err) {
        return new Response('Error retrieving file: ' + err.message, { status: 500 });
      }
    }

    // 9. Student Resource Suggestion Submission (Public)
    if (url.pathname === '/api/suggest' && method === 'POST') {
      if (await isRateLimited(env, `suggest_${clientIp}`, 5, 600)) {
        return jsonResponse({ success: false, error: 'Too many submissions. Please wait 10 minutes.' }, 429);
      }

      try {
        const body = await request.json();
        const { subject, topic, section, resourceLink, note, studentName } = body;

        if (!subject || (!resourceLink && !note)) {
          return jsonResponse({ success: false, error: 'Please provide at least a subject and a link or note.' }, 400);
        }

        const suggestion = {
          id: 'sug_' + Date.now(),
          studentName: studentName || 'Anonymous Student',
          subject: subject.trim(),
          topic: (topic || '').trim(),
          section: section || 'ALL',
          resourceLink: (resourceLink || '').trim(),
          note: (note || '').trim(),
          submittedAt: new Date().toISOString(),
          status: 'pending'
        };

        if (env.FILES_DB) {
          let list = [];
          const raw = await env.FILES_DB.get(SUGGESTIONS_KEY);
          if (raw) list = JSON.parse(raw);
          list.unshift(suggestion);
          if (list.length > 100) list = list.slice(0, 100);
          await env.FILES_DB.put(SUGGESTIONS_KEY, JSON.stringify(list));
        }

        let web3FormsDelivered = false;
        if (env.WEB3FORMS_ACCESS_KEY) {
          try {
            const formData = new FormData();
            formData.append('access_key', env.WEB3FORMS_ACCESS_KEY);
            formData.append('subject', `📚 New LMS Resource Suggestion: ${subject} (${section})`);
            formData.append('from_name', `LMS Portal - ${studentName || 'Student'}`);
            formData.append('message', 
              `New Study Material Submitted:\n\n` +
              `• Subject: ${subject}\n` +
              `• Section: ${section}\n` +
              `• Topic: ${topic || 'General'}\n` +
              `• Link: ${resourceLink || 'None provided'}\n` +
              `• Student Note: ${note || 'None'}\n` +
              `• Submitted At: ${suggestion.submittedAt}`
            );

            const w3Res = await fetch('https://api.web3forms.com/submit', {
              method: 'POST',
              body: formData
            });
            web3FormsDelivered = w3Res.ok;
          } catch (e) {
            console.error('Web3Forms forwarding error:', e);
          }
        }

        // Telegram Bot Instant Alert (Optional)
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          try {
            const tgMsg = `📚 *New StudyMate Resource Suggestion!*\n\n` +
              `👤 *Student:* ${suggestion.studentName}\n` +
              `📖 *Subject:* ${suggestion.subject} (${suggestion.section})\n` +
              `📌 *Topic:* ${suggestion.topic || 'General'}\n` +
              `🔗 *Link:* ${suggestion.resourceLink || 'None provided'}\n` +
              `📝 *Note:* ${suggestion.note || 'None'}\n` +
              `⏰ *Time:* ${new Date(suggestion.submittedAt).toLocaleString()}`;
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: env.TELEGRAM_CHAT_ID,
                text: tgMsg,
                parse_mode: 'Markdown'
              })
            });
          } catch (e) {
            console.error('Telegram notification error:', e);
          }
        }

        // Discord Webhook Alert (Optional)
        if (env.DISCORD_WEBHOOK_URL) {
          try {
            await fetch(env.DISCORD_WEBHOOK_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                username: 'StudyMate Alerts',
                embeds: [{
                  title: `📚 New Resource Suggestion: ${subject} (${section})`,
                  color: 0x3b82f6,
                  fields: [
                    { name: 'Student', value: suggestion.studentName, inline: true },
                    { name: 'Topic', value: suggestion.topic || 'General', inline: true },
                    { name: 'Link', value: suggestion.resourceLink || 'None provided', inline: false },
                    { name: 'Note', value: suggestion.note || 'None', inline: false }
                  ],
                  timestamp: suggestion.submittedAt
                }]
              })
            });
          } catch (e) {
            console.error('Discord notification error:', e);
          }
        }

        return jsonResponse({
          success: true,
          message: 'Thank you! Your resource has been submitted to the admin for review.',
          web3FormsDelivered
        });
      } catch (err) {
        return jsonResponse({ success: false, error: 'Failed to process suggestion', details: err.message }, 500);
      }
    }

    // 10. Admin: Get Pending Suggestions
    if (url.pathname === '/api/suggestions' && method === 'GET') {
      const isAdmin = await checkAdminAuth(request, env);
      if (!isAdmin) {
        return jsonResponse({ success: false, error: 'Unauthorized: Admin privileges required' }, 403);
      }

      let list = [];
      if (env.FILES_DB) {
        const raw = await env.FILES_DB.get(SUGGESTIONS_KEY);
        if (raw) list = JSON.parse(raw);
      }
      return jsonResponse({ success: true, suggestions: list });
    }

    // 11. Admin: Resolve Suggestion
    if (url.pathname.startsWith('/api/suggestions/') && url.pathname.endsWith('/action') && method === 'POST') {
      const isAdmin = await checkAdminAuth(request, env);
      if (!isAdmin) {
        return jsonResponse({ success: false, error: 'Unauthorized: Admin privileges required' }, 403);
      }

      const sugId = url.pathname.split('/')[3];
      const body = await request.json();
      const action = body.action || 'dismissed';

      if (env.FILES_DB) {
        let list = [];
        const raw = await env.FILES_DB.get(SUGGESTIONS_KEY);
        if (raw) list = JSON.parse(raw);
        list = list.map(item => item.id === sugId ? { ...item, status: action } : item);
        await env.FILES_DB.put(SUGGESTIONS_KEY, JSON.stringify(list));
      }

      return jsonResponse({ success: true, message: `Suggestion marked as ${action}` });
    }

    // 12. Admin: Comprehensive Analytics & Dashboard Metrics
    if (url.pathname === '/api/admin/analytics' && method === 'GET') {
      const isAdmin = await checkAdminAuth(request, env);
      if (!isAdmin) {
        return jsonResponse({ success: false, error: 'Unauthorized: Admin privileges required' }, 403);
      }

      try {
        // 1. Traverse file tree to calculate file counts, storage, categories
        let tree = null;
        if (env.FILES_DB) {
          const rawTree = await env.FILES_DB.get(FS_INDEX_KEY);
          if (rawTree) tree = JSON.parse(rawTree);
        }
        if (!tree) tree = DEFAULT_FILE_SYSTEM;

        let totalFiles = 0;
        let totalLinks = 0;
        let totalVideos = 0;
        let totalFolders = 0;
        let totalSizeBytes = 0;
        const categoryCounts = { notes: 0, pyq: 0, video: 0, lab: 0, other: 0 };
        const sectionCounts = { A: 0, B: 0, ALL: 0 };

        function analyzeNode(node) {
          if (!node) return;
          if (node.type === 'folder') {
            totalFolders++;
            if (node.children) {
              for (const child of node.children) {
                analyzeNode(child);
              }
            }
          } else {
            if (node.type === 'file') {
              totalFiles++;
              if (node.fileSize) totalSizeBytes += node.fileSize;
            } else if (node.type === 'youtube') {
              totalVideos++;
            } else {
              totalLinks++;
            }

            const cat = node.category || (node.type === 'youtube' ? 'video' : 'other');
            categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;

            const sec = node.section || 'ALL';
            sectionCounts[sec] = (sectionCounts[sec] || 0) + 1;
          }
        }

        analyzeNode(tree);

        // 2. Fetch visitor & download metrics from KV
        let stats = { totalVisits: 0, totalDownloads: 0, dailyVisits: {}, fileDownloads: {} };
        if (env.FILES_DB) {
          const rawStats = await env.FILES_DB.get(STATS_KEY);
          if (rawStats) stats = JSON.parse(rawStats);
        }

        // 3. Count pending suggestions
        let pendingSuggestions = 0;
        if (env.FILES_DB) {
          const rawSug = await env.FILES_DB.get(SUGGESTIONS_KEY);
          if (rawSug) {
            const list = JSON.parse(rawSug);
            pendingSuggestions = list.filter(s => s.status === 'pending').length;
          }
        }

        // Cloudflare R2 Free Tier Calculations (10 GB Free Tier)
        const storageLimitBytes = R2_FREE_TIER_BYTES;
        const storageUsedBytes = totalSizeBytes;
        const storageRemainingBytes = Math.max(0, storageLimitBytes - storageUsedBytes);
        const storageUsedPercentage = Math.min(100, (storageUsedBytes / storageLimitBytes) * 100);

        return jsonResponse({
          success: true,
          analytics: {
            visitors: {
              total: stats.totalVisits || 0,
              today: (stats.dailyVisits && stats.dailyVisits[new Date().toISOString().split('T')[0]]) || 0,
              daily: stats.dailyVisits || {}
            },
            downloads: {
              total: stats.totalDownloads || 0,
              popularFiles: stats.fileDownloads || {}
            },
            storage: {
              totalSizeBytes,
              formattedUsed: formatBytes(storageUsedBytes),
              formattedRemaining: formatBytes(storageRemainingBytes),
              formattedLimit: formatBytes(storageLimitBytes),
              usedPercentage: storageUsedPercentage.toFixed(2),
              isR2Active: Boolean(env.FILES_BUCKET)
            },
            content: {
              totalFolders,
              totalFiles,
              totalVideos,
              totalLinks,
              totalMaterials: totalFiles + totalVideos + totalLinks,
              categoryCounts,
              sectionCounts,
              pendingSuggestions
            }
          }
        });
      } catch (err) {
        return jsonResponse({ success: false, error: 'Failed to calculate analytics', details: err.message }, 500);
      }
    }

    // 13. Public: Subscribe to Notifications & Device Registration
    if (url.pathname === '/api/notifications/subscribe' && method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        let count = 1;
        if (env.FILES_DB) {
          const raw = await env.FILES_DB.get(SUBSCRIBERS_COUNT_KEY);
          count = raw ? parseInt(raw, 10) : 0;
          if (body.isNew !== false) {
            count += 1;
            await env.FILES_DB.put(SUBSCRIBERS_COUNT_KEY, count.toString());
          }
        }
        return jsonResponse({ success: true, count, message: 'Notification subscription active' });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // 14. Public: Fetch Latest Broadcast & Recent Announcements
    if (url.pathname === '/api/broadcasts/latest' && method === 'GET') {
      try {
        let active = null;
        let recent = [];
        let subscribers = 1;
        if (env.FILES_DB) {
          const [activeRaw, recentRaw, subsRaw] = await Promise.all([
            env.FILES_DB.get(ACTIVE_BROADCAST_KEY),
            env.FILES_DB.get(BROADCASTS_KEY),
            env.FILES_DB.get(SUBSCRIBERS_COUNT_KEY)
          ]);
          if (activeRaw) active = JSON.parse(activeRaw);
          if (recentRaw) recent = JSON.parse(recentRaw);
          if (subsRaw) subscribers = parseInt(subsRaw, 10);
        }
        return jsonResponse({ success: true, active, recent: recent.slice(0, 10), subscribers });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // 15. Admin: Dispatch Broadcast with Cloudflare Edge Telemetry
    if (url.pathname === '/api/admin/broadcast/send' && method === 'POST') {
      const isAdmin = await checkAdminAuth(request, env);
      if (!isAdmin) {
        return jsonResponse({ success: false, error: 'Unauthorized: Admin privileges required' }, 403);
      }

      try {
        const body = await request.json();
        const { title, message, tag, targetUrl, audienceEstimate } = body;
        if (!title || !message) {
          return jsonResponse({ success: false, error: 'Broadcast title and message are required.' }, 400);
        }

        let subscribers = 1;
        let history = [];
        if (env.FILES_DB) {
          const [subsRaw, histRaw] = await Promise.all([
            env.FILES_DB.get(SUBSCRIBERS_COUNT_KEY),
            env.FILES_DB.get(BROADCASTS_KEY)
          ]);
          if (subsRaw) subscribers = parseInt(subsRaw, 10);
          if (histRaw) history = JSON.parse(histRaw);
        }

        const broadcast = {
          id: 'bc_' + Date.now(),
          title: title.trim(),
          message: message.trim(),
          tag: tag || 'Notice',
          targetUrl: (targetUrl || '').trim(),
          dispatchedAt: new Date().toISOString(),
          recipients: audienceEstimate || subscribers || 1,
          status: 'active'
        };

        history.unshift(broadcast);
        if (history.length > 50) history = history.slice(0, 50);

        if (env.FILES_DB) {
          await Promise.all([
            env.FILES_DB.put(ACTIVE_BROADCAST_KEY, JSON.stringify(broadcast)),
            env.FILES_DB.put(BROADCASTS_KEY, JSON.stringify(history))
          ]);
        }

        return jsonResponse({ success: true, broadcast });
      } catch (err) {
        return jsonResponse({ success: false, error: 'Failed to send broadcast', details: err.message }, 500);
      }
    }

    // 16. Admin: Cancel In-flight or Active Broadcast
    if (url.pathname.startsWith('/api/admin/broadcast/cancel/') && method === 'POST') {
      const isAdmin = await checkAdminAuth(request, env);
      if (!isAdmin) {
        return jsonResponse({ success: false, error: 'Unauthorized: Admin privileges required' }, 403);
      }

      const id = url.pathname.replace('/api/admin/broadcast/cancel/', '').trim();
      if (env.FILES_DB) {
        let history = [];
        const histRaw = await env.FILES_DB.get(BROADCASTS_KEY);
        if (histRaw) history = JSON.parse(histRaw);
        history = history.map(b => b.id === id ? { ...b, status: 'canceled', canceledAt: new Date().toISOString() } : b);

        let active = null;
        const activeRaw = await env.FILES_DB.get(ACTIVE_BROADCAST_KEY);
        if (activeRaw) {
          active = JSON.parse(activeRaw);
          if (active.id === id) {
            active = null;
          }
        }

        await Promise.all([
          env.FILES_DB.put(BROADCASTS_KEY, JSON.stringify(history)),
          active ? env.FILES_DB.put(ACTIVE_BROADCAST_KEY, JSON.stringify(active)) : env.FILES_DB.delete(ACTIVE_BROADCAST_KEY)
        ]);
      }

      return jsonResponse({ success: true, message: 'Broadcast canceled and recalled successfully.' });
    }

    // 17. Admin: Broadcast Statistics & Historical Audit Logs
    if (url.pathname === '/api/admin/broadcast/stats' && method === 'GET') {
      const isAdmin = await checkAdminAuth(request, env);
      if (!isAdmin) {
        return jsonResponse({ success: false, error: 'Unauthorized: Admin privileges required' }, 403);
      }

      let subscribers = 0;
      let history = [];
      let active = null;
      if (env.FILES_DB) {
        const [subsRaw, histRaw, activeRaw] = await Promise.all([
          env.FILES_DB.get(SUBSCRIBERS_COUNT_KEY),
          env.FILES_DB.get(BROADCASTS_KEY),
          env.FILES_DB.get(ACTIVE_BROADCAST_KEY)
        ]);
        if (subsRaw) subscribers = parseInt(subsRaw, 10);
        if (histRaw) history = JSON.parse(histRaw);
        if (activeRaw) active = JSON.parse(activeRaw);
      }

      return jsonResponse({
        success: true,
        stats: {
          totalSubscribers: subscribers,
          totalBroadcastsSent: history.filter(b => b.status === 'active' || b.status === 'delivered').length,
          totalCanceled: history.filter(b => b.status === 'canceled').length,
          activeBroadcast: active,
          history
        }
      });
    }

    // 18. Admin: Delete Broadcast History Item
    if (url.pathname.startsWith('/api/admin/broadcast/') && method === 'DELETE') {
      const isAdmin = await checkAdminAuth(request, env);
      if (!isAdmin) {
        return jsonResponse({ success: false, error: 'Unauthorized: Admin privileges required' }, 403);
      }

      const id = url.pathname.replace('/api/admin/broadcast/', '').trim();
      if (env.FILES_DB) {
        let history = [];
        const histRaw = await env.FILES_DB.get(BROADCASTS_KEY);
        if (histRaw) history = JSON.parse(histRaw);
        history = history.filter(b => b.id !== id);

        const activeRaw = await env.FILES_DB.get(ACTIVE_BROADCAST_KEY);
        let active = activeRaw ? JSON.parse(activeRaw) : null;
        if (active && active.id === id) {
          await env.FILES_DB.delete(ACTIVE_BROADCAST_KEY);
        }
        await env.FILES_DB.put(BROADCASTS_KEY, JSON.stringify(history));
      }

      return jsonResponse({ success: true, message: 'Broadcast record deleted.' });
    }


    // Default: Serve frontend HTML application & Track User Visit
    await trackEvent(env, 'visit');

    return new Response(HTML_TEMPLATE, {
      headers: getSecurityHeaders('text/html;charset=UTF-8')
    });
  }
};
