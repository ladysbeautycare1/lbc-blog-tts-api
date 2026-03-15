/**
 * Blog TTS API - Cloudflare Workers
 * Google Service Account + Google Drive Caching
 */

import crypto from 'crypto';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

  if (!response.ok) throw new Error('Token request failed');
  const data = await response.json();
  return data.access_token;
}

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

async function fetchBlogContent(blogUrl) {
  const response = await fetch(blogUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
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

function generateCacheKey(blogPostId, content) {
  const hash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 8);
  return `lbc-blog-audio-${blogPostId}-${hash}.mp3`;
}

async function findAudioInDrive(accessToken, driveFolderId, cacheKey) {
  try {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=name="${cacheKey}" and "${driveFolderId}" in parents and trashed=false&spaces=drive&fields=files(id,name,webContentLink,createdTime)&pageSize=1`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (!response.ok) return null;

    const data = await response.json();
    if (data.files?.length > 0) {
      return {
        fileId: data.files[0].id,
        fileName: data.files[0].name,
        downloadLink: data.files[0].webContentLink,
        createdTime: data.files[0].createdTime
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

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
    throw new Error(error.error.message);
  }

  const data = await response.json();
  if (!data.audioContent) throw new Error('No audio content');
  return Buffer.from(data.audioContent, 'base64');
}

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
    throw new Error(error.error.message);
  }

  const data = await response.json();
  return {
    fileId: data.id,
    fileName: cacheKey,
    downloadLink: data.webContentLink,
    createdTime: data.createdTime,
    size: data.size
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // Root endpoint
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

      // Health check
      if (url.pathname === '/api/blog/health') {
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
      if (url.pathname === '/api/blog/read-aloud' && request.method === 'POST') {
        const data = await request.json();
        const { blogPostId, blogUrl, blogContent } = data;

        if (!blogPostId || (!blogUrl && !blogContent)) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Missing required fields'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        const driveFolderId = env.GOOGLE_DRIVE_FOLDER_ID.trim();
        const accessToken = await getAccessToken(serviceAccountJSON);

        let content = blogContent;
        if (!content && blogUrl) {
          content = await fetchBlogContent(blogUrl);
        }

        const cacheKey = generateCacheKey(blogPostId, content);
        const cached = await findAudioInDrive(accessToken, driveFolderId, cacheKey);

        if (cached) {
          return new Response(JSON.stringify({
            success: true,
            cached: true,
            audioUrl: cached.downloadLink,
            fileId: cached.fileId,
            createdTime: cached.createdTime
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        const audioBuffer = await synthesizeSpeech(accessToken, content);
        const uploaded = await uploadAudioToDrive(accessToken, driveFolderId, cacheKey, audioBuffer);

        return new Response(JSON.stringify({
          success: true,
          cached: false,
          audioUrl: uploaded.downloadLink,
          fileId: uploaded.fileId,
          createdTime: uploaded.createdTime,
          size: uploaded.size
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 404
      return new Response(JSON.stringify({
        error: 'Not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });

    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
};