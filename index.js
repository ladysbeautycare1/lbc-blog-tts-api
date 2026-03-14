/**
 * Blog TTS API - Cloudflare Workers
 * Production-ready with Workload Identity Federation
 */

import { GoogleAuth } from 'google-auth-library';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { google } from 'googleapis';
import crypto from 'crypto';

// ─── LOGGER ───────────────────────────────────────────
const log = {
  info: (msg, data) => console.log(`[INFO] ${msg}`, data || ''),
  error: (msg, err) => console.error(`[ERROR] ${msg}`, err?.message || err),
  warn: (msg, data) => console.warn(`[WARN] ${msg}`, data || '')
};

// ─── CORS HEADERS ──────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── FETCH BLOG CONTENT ────────────────────────────────
async function fetchBlogContent(blogUrl) {
  const response = await fetch(blogUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const html = await response.text();
  
  // Remove scripts, styles, nav, footer
  let content = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');

  // Extract main content
  const mainMatch = content.match(/<(article|main|div[^>]*class="[^"]*content[^"]*"[^>]*)>(.+?)<\/\1>/is);
  if (mainMatch) content = mainMatch[2];

  // Strip HTML and limit
  content = content
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 4500);

  if (content.length < 100) throw new Error('Insufficient content');
  return content;
}

// ─── GENERATE CACHE KEY ───────────────────────────────
function generateCacheKey(blogPostId, content) {
  const hash = crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .substring(0, 8);
  return `lbc-blog-audio-${blogPostId}-${hash}.mp3`;
}

// ─── INITIALIZE GOOGLE CLIENTS ─────────────────────────
async function initializeClients(env) {
  const auth = new GoogleAuth({
    projectId: env.GOOGLE_PROJECT_ID,
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/texttospeech'
    ]
  });

  const ttsClient = new TextToSpeechClient({
    projectId: env.GOOGLE_PROJECT_ID,
    auth
  });

  const driveClient = google.drive({ version: 'v3', auth });

  return { ttsClient, driveClient, env };
}

// ─── FIND AUDIO IN DRIVE ───────────────────────────────
async function findAudioInDrive(driveClient, env, cacheKey) {
  try {
    const response = await driveClient.files.list({
      q: `name="${cacheKey}" and "${env.GOOGLE_DRIVE_FOLDER_ID}" in parents and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name, webContentLink, createdTime)',
      pageSize: 1,
    });

    if (response.data.files && response.data.files.length > 0) {
      const file = response.data.files[0];
      log.info(`✓ Cache hit: ${cacheKey}`);
      return {
        fileId: file.id,
        fileName: file.name,
        downloadLink: file.webContentLink,
        createdTime: file.createdTime
      };
    }
    return null;
  } catch (error) {
    log.warn('Cache lookup failed', error);
    return null;
  }
}

// ─── SYNTHESIZE SPEECH ─────────────────────────────────
async function synthesizeSpeech(ttsClient, text) {
  const request = {
    input: { text },
    voice: {
      languageCode: 'en-AU',
      name: 'en-AU-Neural2-C',
      ssmlGender: 'FEMALE',
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 0.95,
      pitch: 0.0,
      volumeGainDb: 0.0,
    },
  };

  const [response] = await ttsClient.synthesizeSpeech(request);
  if (!response.audioContent) throw new Error('No audio content');
  
  log.info(`✓ Audio synthesized: ${response.audioContent.length} bytes`);
  return response.audioContent;
}

// ─── UPLOAD TO DRIVE ───────────────────────────────────
async function uploadAudioToDrive(driveClient, env, cacheKey, audioBuffer) {
  const file = {
    name: cacheKey,
    parents: [env.GOOGLE_DRIVE_FOLDER_ID],
    description: `LBC Blog Audio - ${new Date().toISOString()}`,
    mimeType: 'audio/mpeg'
  };

  const { data } = await driveClient.files.create({
    resource: file,
    media: {
      mimeType: 'audio/mpeg',
      body: audioBuffer,
    },
    fields: 'id, webContentLink, createdTime, size',
  });

  log.info(`✓ Audio uploaded: ${data.id}`);
  return {
    fileId: data.id,
    fileName: cacheKey,
    downloadLink: data.webContentLink,
    createdTime: data.createdTime,
    size: data.size
  };
}

// ─── VALIDATE INPUT ───────────────────────────────────
function validateInput(blogPostId, blogUrl, blogContent) {
  const errors = [];
  if (!blogPostId) errors.push('blogPostId required');
  if (!blogUrl && !blogContent) errors.push('blogUrl or blogContent required');
  if (blogContent && blogContent.length < 100) errors.push('blogContent must be 100+ chars');
  return errors;
}

// ─── MAIN HANDLER ──────────────────────────────────────
async function handleReadAloud(request, env) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const startTime = Date.now();

  try {
    const data = await request.json();
    const { blogPostId, blogUrl, blogContent } = data;

    // Validate
    const errors = validateInput(blogPostId, blogUrl, blogContent);
    if (errors.length > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid input',
        details: errors,
        requestId
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    log.info(`[${requestId}] Processing: ${blogPostId}`);

    // Initialize clients
    const { ttsClient, driveClient } = await initializeClients(env);

    // Fetch content if needed
    let content = blogContent;
    if (!content && blogUrl) {
      content = await fetchBlogContent(blogUrl);
    }

    // Generate cache key
    const cacheKey = generateCacheKey(blogPostId, content);
    log.info(`[${requestId}] Cache key: ${cacheKey}`);

    // Check cache
    const cached = await findAudioInDrive(driveClient, env, cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      return new Response(JSON.stringify({
        success: true,
        cached: true,
        audioUrl: cached.downloadLink,
        fileId: cached.fileId,
        createdTime: cached.createdTime,
        message: 'Cached audio',
        requestId,
        duration
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Generate audio
    log.info(`[${requestId}] Generating audio`);
    const audioBuffer = await synthesizeSpeech(ttsClient, content);

    // Upload
    log.info(`[${requestId}] Uploading to Drive`);
    const uploaded = await uploadAudioToDrive(driveClient, env, cacheKey, audioBuffer);

    const duration = Date.now() - startTime;
    log.info(`[${requestId}] Complete: ${duration}ms`);

    return new Response(JSON.stringify({
      success: true,
      cached: false,
      audioUrl: uploaded.downloadLink,
      fileId: uploaded.fileId,
      createdTime: uploaded.createdTime,
      size: uploaded.size,
      message: 'New audio generated',
      requestId,
      duration
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    log.error(`[${requestId}] Error`, error);

    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      requestId,
      duration
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// ─── HEALTH CHECK ─────────────────────────────────────
async function handleHealth(env) {
  try {
    await initializeClients(env);
    return new Response(JSON.stringify({
      status: 'healthy',
      service: 'LBC Blog TTS API',
      platform: 'Cloudflare Workers',
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      status: 'unhealthy',
      error: error.message
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// ─── ROOT ─────────────────────────────────────────────
function handleRoot() {
  return new Response(JSON.stringify({
    service: 'LBC Blog TTS API',
    platform: 'Cloudflare Workers',
    endpoints: {
      health: 'GET /api/blog/health',
      readAloud: 'POST /api/blog/read-aloud'
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// ─── MAIN EXPORT ───────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response('OK', { status: 204, headers: corsHeaders });
    }

    // Routes
    if (url.pathname === '/') {
      return handleRoot();
    }

    if (url.pathname === '/api/blog/health' && request.method === 'GET') {
      return await handleHealth(env);
    }

    if (url.pathname === '/api/blog/read-aloud' && request.method === 'POST') {
      return await handleReadAloud(request, env);
    }

    // 404
    return new Response(JSON.stringify({
      error: 'Not found',
      path: url.pathname
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};
