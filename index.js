/**
 * Blog TTS API - Cloudflare Workers v3.2
 * Proper WordPress extraction: <div class="entry-content">
 * Single TTS call for smooth playback
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── JWT & AUTH ───────────────────────────────────────────

async function getAccessToken(serviceAccountJSON) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: serviceAccountJSON.client_email,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/cloud-platform',
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

    if (!response.ok) throw new Error(`Token failed: ${response.status}`);
    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error('Auth error:', error.message);
    throw error;
  }
}

function base64url(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function signJWT(header, payload, privateKey) {
  const headerEncoded = base64url(JSON.stringify(header));
  const payloadEncoded = base64url(JSON.stringify(payload));
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

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(message)
  );
  const signatureEncoded = base64url(String.fromCharCode(...new Uint8Array(signature)));

  return `${message}.${signatureEncoded}`;
}

// ─── FETCH & EXTRACT BLOG CONTENT ─────────────────────────

async function fetchBlogContent(blogUrl) {
  try {
    const response = await fetch(blogUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let html = await response.text();

    // Extract title
    let title = '';
    const titleMatch = html.match(/<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>(.*?)<\/h1>/is)
      || html.match(/<title[^>]*>(.*?)<\/title>/is);
    if (titleMatch) {
      title = titleMatch[1].replace(/<[^>]+>/g, '').split('|')[0].trim();
    }

    // Remove scripts, styles, nav, footer
    html = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')
      .replace(/<img[^>]*>/gi, '')
      .replace(/<figure\b[\s\S]*?<\/figure>/gi, '');

    // Extract ENTRY-CONTENT (WordPress standard)
    let content = '';
    const entryMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    
    if (entryMatch) {
      content = entryMatch[1];
    } else {
      // Fallback: extract article
      const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
      if (articleMatch) {
        content = articleMatch[1];
      } else {
        // Last resort
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) {
          content = bodyMatch[1];
        }
      }
    }

    // Convert HTML to text
    let text = content
      .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n$1\n\n')
      .replace(/<p[^>]*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '\n• $1\n')
      .replace(/<ul[^>]*>/gi, '\n')
      .replace(/<\/ul>/gi, '\n')
      .replace(/<ol[^>]*>/gi, '\n')
      .replace(/<\/ol>/gi, '\n')
      .replace(/<div[^>]*>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<span[^>]*>(.*?)<\/span>/gi, '$1')
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '$1')
      .replace(/<em[^>]*>(.*?)<\/em>/gi, '$1')
      .replace(/<a[^>]*>(.*?)<\/a>/gi, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, ' and ')
      .replace(/&lt;/g, '')
      .replace(/&gt;/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&ndash;/g, ' - ')
      .replace(/&mdash;/g, ' - ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n /g, '\n')
      .trim();

    if (text.length < 100) throw new Error('Content too short');
    
    if (title) {
      text = title + '.\n\n' + text;
    }

    console.log(`Extracted ${text.length} characters from blog`);
    return text;
  } catch (error) {
    console.error('Fetch error:', error.message);
    throw error;
  }
}

// ─── TEXT TO SSML ─────────────────────────────────────────

function textToSSML(text) {
  let ssml = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Add natural pauses
  ssml = ssml.replace(/\n\n+/g, '<break time="800ms"/>');
  ssml = ssml.replace(/\n/g, '<break time="400ms"/>');
  ssml = ssml.replace(/([.!?])\s+/g, '$1<break time="350ms"/> ');
  ssml = ssml.replace(/:\s+/g, ':<break time="300ms"/> ');
  ssml = ssml.replace(/;\s+/g, ';<break time="250ms"/> ');
  ssml = ssml.replace(/,\s+/g, ',<break time="150ms"/> ');

  return `<speak>${ssml}</speak>`;
}

// ─── CALL GOOGLE TTS ──────────────────────────────────────

async function synthesizeSpeech(accessToken, text) {
  try {
    const ssml = textToSSML(text);
    const ssmlBytes = new TextEncoder().encode(ssml);
    
    console.log(`SSML: ${ssmlBytes.length} bytes (limit: 5000)`);

    const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: { ssml },
        voice: {
          languageCode: 'en-AU',
          name: 'en-AU-Neural2-C',
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 0.92,
          pitch: 0,
          volumeGainDb: 0,
        },
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`TTS ${response.status}: ${err.substring(0, 200)}`);
    }

    const data = await response.json();
    if (!data.audioContent) throw new Error('No audio in response');

    const binaryString = atob(data.audioContent);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    console.log(`Generated ${bytes.length} bytes of audio`);
    return bytes;
  } catch (error) {
    console.error('TTS error:', error.message);
    throw error;
  }
}

// ─── WORKER ENTRY POINT ───────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (url.pathname === '/') {
        return jsonResponse({
          service: 'LBC Blog TTS API',
          version: '3.2',
          features: ['full-wordpress-extraction', 'smooth-playback'],
          extraction: 'div.entry-content (WordPress standard)'
        });
      }

      if (url.pathname === '/api/blog/health') {
        try {
          const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
          await getAccessToken(serviceAccountJSON);
          return jsonResponse({ status: 'healthy', version: '3.2' });
        } catch (error) {
          return jsonResponse({ status: 'unhealthy', error: error.message }, 503);
        }
      }

      if (url.pathname === '/api/blog/read-aloud' && request.method === 'POST') {
        const data = await request.json();
        const { blogPostId, blogUrl, blogContent } = data;

        if (!blogPostId || (!blogUrl && !blogContent)) {
          return jsonResponse({ success: false, error: 'Missing parameters' }, 400);
        }

        const serviceAccountJSON = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        const accessToken = await getAccessToken(serviceAccountJSON);

        // Get content
        let content = blogContent;
        if (!content && blogUrl) {
          content = await fetchBlogContent(blogUrl);
        }

        // Check SSML size
        const testSSML = textToSSML(content);
        const ssmlBytes = new TextEncoder().encode(testSSML).length;
        
        console.log(`Blog ${blogPostId}: ${content.length} chars, SSML ${ssmlBytes} bytes`);

        // If SSML too large, truncate gracefully
        if (ssmlBytes > 4800) {
          console.log('Truncating at sentence boundary');
          let truncated = content.substring(0, 4000);
          const lastSentence = truncated.lastIndexOf('.');
          if (lastSentence > 2000) {
            content = truncated.substring(0, lastSentence + 1);
          }
        }

        // Generate audio
        const audioBytes = await synthesizeSpeech(accessToken, content);

        // Convert to base64
        let binaryString = '';
        for (let i = 0; i < audioBytes.length; i++) {
          binaryString += String.fromCharCode(audioBytes[i]);
        }
        const audioBase64 = btoa(binaryString);

        return jsonResponse({
          success: true,
          cached: false,
          audioBase64: audioBase64,
          contentLength: audioBytes.length,
          totalChars: content.length
        });
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (error) {
      console.error('Worker error:', error.message);
      return jsonResponse({ success: false, error: error.message }, 500);
    }
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
