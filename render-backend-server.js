/**
 * LBC Blog TTS - Render Backend with Google Drive Caching
 * IMPROVED: Multi-chunk, SSML, caching, % reads as percent, breaks after titles/subtitles/bullets
 */

const express = require('express');
const cors = require('cors');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const GoogleDriveCache = require('./google-drive-cache');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

let ttsClient;
let driveCache;

async function initializeGoogle() {
  try {
    const serviceAccountKeyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const googleProjectId = process.env.GOOGLE_PROJECT_ID;
    const workspaceUserEmail = process.env.GOOGLE_WORKSPACE_USER_EMAIL;
    const driveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || '1BBY-9sfGExHSLv_R2Y8Oznk5OMKhNDfl';

    if (!serviceAccountKeyString) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
    }

    let serviceAccountJSON;
    try {
      serviceAccountJSON = JSON.parse(serviceAccountKeyString);
    } catch (e) {
      serviceAccountJSON = JSON.parse(
        Buffer.from(serviceAccountKeyString, 'base64').toString()
      );
    }

    // Initialize TTS Client
    ttsClient = new TextToSpeechClient({
      credentials: serviceAccountJSON,
      projectId: googleProjectId,
    });

    console.log('✅ Google Cloud TTS initialized');

    // Initialize Drive Cache (if workspace email is provided)
    if (workspaceUserEmail) {
      driveCache = new GoogleDriveCache(
        serviceAccountJSON,
        workspaceUserEmail,
        driveFolderId
      );
      await driveCache.initialize();
      console.log('✅ Google Drive Cache initialized');
    } else {
      console.log('⚠️  GOOGLE_WORKSPACE_USER_EMAIL not set - caching disabled');
    }
  } catch (error) {
    console.error('❌ Google Cloud init error:', error.message);
    process.exit(1);
  }
}

function splitIntoChunks(text, maxSize = 2000) {
  const chunks = [];
  let current = '';

  // FIRST: Split on major sections (titles/subtitles followed by content)
  const sections = text.split(/\n(?=[A-Z][A-Za-z\s]{3,80}(?:\n|$))/);

  for (const section of sections) {
    if (!section.trim()) continue;

    // WITHIN each section: split by sentences
    const sentences = section.match(/[^.!?]*[.!?]+/g) || [section];

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      // If adding this sentence would exceed maxSize, start a new chunk
      if (current.length + trimmed.length > maxSize && current.length > 0) {
        chunks.push(current.trim());
        current = trimmed;
      } else {
        current += (current ? ' ' : '') + trimmed;
      }
    }

    // End of section - if there's content, add it as a chunk
    if (current.trim()) {
      chunks.push(current.trim());
      current = '';
    }

    // ADD A PAUSE BETWEEN SECTIONS
    chunks.push('[PAUSE_2000ms]');
  }

  // Remove trailing pause
  if (chunks.length > 0 && chunks[chunks.length - 1] === '[PAUSE_2000ms]') {
    chunks.pop();
  }

  console.log(`📄 Split into ${chunks.length} chunks (including pauses)`);
  return chunks;
}

function textToSSML(text) {
  let ssml = text
    // FIRST: Replace special characters with words BEFORE XML escaping
    .replace(/%/g, ' percent ')
    .replace(/\$/g, ' dollar ')
    .replace(/#/g, ' number ')
    // NOW: Escape XML special chars
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // TITLE BREAKS
  ssml = ssml.replace(/^([A-Z][A-Za-z0-9\s]{5,80})(\n)/gm, '$1<break strength="x-strong" time="1500ms"/>\n');

  // SUBTITLE BREAKS
  ssml = ssml.replace(/^([A-Z][A-Za-z0-9\s]{5,80})(\n)(?=[A-Z])/gm, '$1<break strength="strong" time="1200ms"/>\n');

  // BULLET POINT BREAKS
  ssml = ssml.replace(/([-•*][^\n]+)(\n)/gm, '$1<break strength="medium" time="800ms"/>$2');

  // PARAGRAPH BREAKS
  ssml = ssml.replace(/\n\n+/g, '<break strength="strong" time="1000ms"/>');

  // SENTENCE ENDINGS
  ssml = ssml.replace(/([.!?])(\s+)(?=[A-Z])/g, '$1<break time="600ms"/>$2');

  // COMMA PAUSES
  ssml = ssml.replace(/,(\s+)/g, ',<break time="250ms"/>$1');

  return `<speak>${ssml}</speak>`;
}

async function synthesizeChunk(text, chunkIndex) {
  try {
    // Skip pause markers
    if (text === '[PAUSE_2000ms]') {
      return Buffer.from('');
    }

    const ssml = textToSSML(text);
    const ssmlSize = Buffer.byteLength(ssml, 'utf8');

    if (ssmlSize > 4800) {
      throw new Error(`SSML too large: ${ssmlSize} bytes`);
    }

    const request = {
      input: { ssml },
      voice: {
        languageCode: 'en-AU',
        name: 'en-AU-Neural2-C',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.92,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    console.log(`🔊 Chunk ${chunkIndex}: ${response.audioContent.length} bytes`);
    return response.audioContent;
  } catch (error) {
    console.error(`❌ Chunk ${chunkIndex} error:`, error.message);
    throw error;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'LBC Blog TTS Render Backend',
    version: '4.0.0',
    caching: driveCache ? 'enabled' : 'disabled',
  });
});

// OPTIMIZED: Generate audio endpoint with caching
app.post('/api/blog/generate-audio', async (req, res) => {
  const startTime = Date.now();

  try {
    const { blogContent, blogText, blogUrl, blogPostId } = req.body;

    const textContent = blogContent || blogText;

    if (!textContent && !blogUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing blogContent/blogText or blogUrl',
      });
    }

    let content = textContent;
    if (!content && blogUrl) {
      try {
        const response = await fetch(blogUrl);
        const html = await response.text();

        const match = html.match(
          /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i
        );
        if (match) {
          content = match[1]
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, ' and ')
            .replace(/&nbsp;/g, ' ')
            .trim();
        }
      } catch (fetchError) {
        return res.status(400).json({
          success: false,
          error: 'Could not fetch blog content',
        });
      }
    }

    if (!content || content.length < 100) {
      return res.status(400).json({
        success: false,
        error: 'Content too short or empty',
      });
    }

    console.log(`\n📝 Processing blog: ${content.length} chars`);

    // STEP 1: Check Drive cache
    let audioChunks = [];
    let fromCache = false;

    if (driveCache) {
      const contentHash = driveCache.generateContentHash(content);
      const cachedAudio = await driveCache.getCachedAudio(contentHash, blogPostId);

      if (cachedAudio) {
        console.log(`💾 Using cached audio (full)`);
        fromCache = true;
        return res.json({
          success: true,
          audioChunks: [
            {
              index: 0,
              audioBase64: Buffer.from(cachedAudio).toString('base64'),
              textLength: content.length,
            },
          ],
          totalChunks: 1,
          totalChars: content.length,
          generationTime: Date.now() - startTime,
          fromCache: true,
        });
      }
    }

    // STEP 2: Generate fresh audio chunks
    const chunks = splitIntoChunks(content, 2000);
    console.log(`🎙️  Generating ${chunks.length} audio chunks...\n`);

    const synthPromises = chunks.map((chunk, index) =>
      synthesizeChunk(chunk, index)
        .then(audioBuffer => {
          audioChunks[index] = {
            index: index,
            audioBase64: audioBuffer.length > 0 ? audioBuffer.toString('base64') : '',
            textLength: chunk.length,
          };
          console.log(`✅ Chunk ${index + 1}/${chunks.length} ready`);
        })
        .catch(error => {
          console.error(`❌ Chunk ${index} failed:`, error.message);
          throw error;
        })
    );

    await Promise.all(synthPromises);

    audioChunks.sort((a, b) => a.index - b.index);
    const validChunks = audioChunks.filter(c => c.audioBase64 || c.audioBase64 === '');

    console.log(`\n✅ All ${validChunks.length} chunks generated in ${Date.now() - startTime}ms\n`);

    // STEP 3: Cache the audio to Drive (combine chunks into single MP3)
    if (driveCache && validChunks.length > 0) {
      try {
        // Combine all audio chunks for caching
        const audioBuffers = validChunks
          .filter(c => c.audioBase64)
          .map(c => Buffer.from(c.audioBase64, 'base64'));

        if (audioBuffers.length > 0) {
          const combinedAudio = Buffer.concat(audioBuffers);
          const contentHash = driveCache.generateContentHash(content);

          await driveCache.saveAudioCache(combinedAudio, contentHash, blogPostId);
        }
      } catch (cacheError) {
        console.error(`⚠️  Cache save failed: ${cacheError.message}`);
        // Don't fail the request - caching is optional
      }
    }

    res.json({
      success: true,
      audioChunks: validChunks,
      totalChunks: validChunks.length,
      totalChars: content.length,
      generationTime: Date.now() - startTime,
      fromCache: false,
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Cache management endpoint (optional)
app.post('/api/cache/cleanup', async (req, res) => {
  try {
    if (!driveCache) {
      return res.status(400).json({
        success: false,
        error: 'Drive caching not enabled',
      });
    }

    await driveCache.cleanupOldCache(48); // 48 hours

    res.json({
      success: true,
      message: 'Cache cleanup completed',
    });
  } catch (error) {
    console.error('❌ Cleanup error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initializeGoogle();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 LBC Blog TTS Render Backend v4.0 running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 Generate: POST http://localhost:${PORT}/api/blog/generate-audio`);
    if (driveCache) {
      console.log(`📍 Cache cleanup: POST http://localhost:${PORT}/api/cache/cleanup\n`);
    }
  });
}

start().catch(error => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});
