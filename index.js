/**
 * Blog TTS API - Cloudflare Workers
 * Google Cloud Text-to-Speech + Drive Caching
 * Service Account JSON Authentication
 */

import crypto from 'crypto';

const log = {
  info: (msg, data) => console.log(`[INFO] ${msg}`, data || ''),
  error: (msg, err) => console.error(`[ERROR] ${msg}`, err?.message || err),
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Get access token from service account
async function getAccessToken(serviceAccountJSON) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccountJSON.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const jwt = await signJWT(header, payload, serviceAccountJSON.private_key);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });

  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

// Sign JWT with private key
async function signJWT(header, payload, privateKey) {
  const headerEncoded = btoa(JSON.stringify(header));
  const payloadEncoded = btoa(JSON.stringify(payload));
  const message = `${headerEncoded}.${payloadEncoded}`;

  const keyData = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\n/g, '');
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(message));
  const signatureEncoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${message}.${signatureEncoded}`;
}

// Fetch and clean blog content
async function fetchBlogContent(blogUrl) {
  const response = await fetch(blogUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  let html = await response.text();
  
  html = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');

  const mainMatch = html.match(/<(article|main|div[^>]*class="[^"]*content[^"]*"[^>]*)>(.+?)<\/\1>/is);
  if (mainMatch) html = mainMatch[2];

  const content = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 4500);

  if (content.length < 100) throw new Error('Insufficient content');
  return content;
}

// Generate cache key
function generateCacheKey(blogPostId, content) {
  const hash = crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .substring(0, 8);
  return `lbc-blog-audio-${blogPostId}-${hash}.mp3`;
}

// Find audio in Google Drive
async function findAudioInDrive(accessToken, driveFolderId, cacheKey) {
  try {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name="${cacheKey}" and "${driveFolderId}" in parents and trashed=false&spaces=drive&fields=files(id,name,webContentLink,createdTime)&pageSize=1`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    if (!response.ok) return null;

    const data = await response.json();
    if (data.files?.length > 0) {
      const file = data.files[0];
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
    console.warn('Cache lookup failed:', error.message);
    return null;
  }
}

// Synthesize speech
async function synthesizeSpeech(accessToken, text) {
  const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: { text },
      voice: {
        languageCode: 'en-AU',
        name: 'en-AU-Neural2-C',
        ssmlGender: 'FEMALE',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.95,
      },
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`TTS API error: ${error.error.message}`);
  }

  const data = await response.json();
  if (!data.audioContent) throw new Error('No audio content');
  
  log.info(`✓ Audio synthesized`);
  return Buffer.from(data.audioContent, 'base64');
}

// Upload to Google Drive
async function uploadAudioToDrive(accessToken, driveFolderId, cacheKey, audioBuffer) {
  const file = {
    name: cacheKey,
    parents: [driveFolderId],
    description: `LBC Blog Audio - ${new Date().toISOString()}`,
    mimeType: 'audio/mpeg'
  };

  const boundary = '===============7330845974216740156==';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const body = delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(file) + delimiter + 'Content-Type: audio/mpeg\r\n\r\n';
  const multipartBody = Buffer.concat([Buffer.from(body), audioBuffer, Buffer.from(closeDelim)]);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: multipartBody
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Drive upload failed: ${error.error.message}`);
  }

  const data = await response.json();
  log.info(`✓ Audio uploaded`);
  return {
    fileId: data.id,
    fileName: cacheKey,
    downloadLink: data.webContentLink,
    createdTime: data.createdTime,
    size: data.size
  };
}

// Validate input
function validateInput(blogPostId, blogUrl, blogContent) {
  const errors = [];
  if (!blogPostId) errors.push('blogPostId required');
  if (!blogUrl && !blogContent) errors.push('blogUrl or blogContent required');
  if (blogContent && blogContent.length < 100) errors.push('blogContent must be 100+ chars');
  return errors;
}

// Health check
async function handleHealth(env) {
  try {
    const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    await getAccessToken(serviceAccountJSON);
    
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

// Read aloud endpoint
async function handleReadAloud(request, env) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const startTime = Date.now();

  try {
    const data = await request.json();
    const { blogPostId, blogUrl, blogContent } = data;

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

    const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const driveFolderId = env.GOOGLE_DRIVE_FOLDER_ID;
    const accessToken = await getAccessToken(serviceAccountJSON);

    let content = blogContent;
    if (!content && blogUrl) {
      content = await fetchBlogContent(blogUrl);
    }

    const cacheKey = generateCacheKey(blogPostId, content);
    const cached = await findAudioInDrive(accessToken, driveFolderId, cacheKey);

    if (cached) {
      const duration = Date.now() - startTime;
      return new Response(JSON.stringify({
        success: true,
        cached: true,
        audioUrl: cached.downloadLink,
        fileId: cached.fileId,
        createdTime: cached.createdTime,
        requestId,
        duration
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const audioBuffer = await synthesizeSpeech(accessToken, content);
    const uploaded = await uploadAudioToDrive(accessToken, driveFolderId, cacheKey, audioBuffer);

    const duration = Date.now() - startTime;

    return new Response(JSON.stringify({
      success: true,
      cached: false,
      audioUrl: uploaded.downloadLink,
      fileId: uploaded.fileId,
      createdTime: uploaded.createdTime,
      size: uploaded.size,
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response('OK', { status: 204, headers: corsHeaders });
    }

    if (url.pathname === '/') {
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

    if (url.pathname === '/api/blog/health') {
      return await handleHealth(env);
    }

    if (url.pathname === '/api/blog/read-aloud' && request.method === 'POST') {
      return await handleReadAloud(request, env);
    }

    return new Response(JSON.stringify({
      error: 'Not found',
      path: url.pathname
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
};