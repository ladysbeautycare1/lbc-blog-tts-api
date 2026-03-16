/**
 * LBC Blog TTS - Render Backend (Final Clean Version)
 * Removes titles/subtitles before processing - reads ONLY main content
 */

const express = require('express');
const cors = require('cors');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

let ttsClient;

async function initializeGoogle() {
  try {
    const serviceAccountKeyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    
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

    ttsClient = new TextToSpeechClient({
      credentials: serviceAccountJSON,
      projectId: process.env.GOOGLE_PROJECT_ID
    });

    console.log('✅ Google Cloud services initialized');
  } catch (error) {
    console.error('❌ Google Cloud init error:', error.message);
    process.exit(1);
  }
}

function splitIntoChunks(text, maxSize = 2000) {
  const chunks = [];
  let current = '';

  // REMOVE TITLES AND SUBTITLES - Don't read them
  // This removes lines that look like titles/subtitles
  let cleanedText = text
    // Remove all-caps titles (like "PCOS & HAIR GROWTH")
    .replace(/^[A-Z][A-Z\s]{10,100}$/gm, '')
    // Remove Title Case lines (short lines that are titles)
    .replace(/^([A-Z][a-z]*(?:\s+[A-Z][a-z]*)*){2,}$/gm, '')
    // Remove single sentence lines that are too short (likely titles)
    .replace(/^[A-Z][^.!?]{5,80}$/gm, '')
    // Clean up extra newlines left behind
    .replace(/\n\n+/g, '\n\n')
    .trim();

  // Split by sentences
  const sentences = cleanedText.match(/[^.!?]*[.!?]+/g) || [cleanedText];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed || trimmed.length < 20) continue;

    if (current.length + trimmed.length > maxSize && current.length > 0) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current += (current ? ' ' : '') + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  console.log(`📄 Split into ${chunks.length} chunks (titles/subtitles removed)`);
  return chunks;
}

function textToSSML(text) {
  let ssml = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // STRONG BREAK AT VERY BEGINNING (after title)
  ssml = ssml.replace(/^([^\n]+)\n([^\n]+)\n/, '$1<break strength="x-strong" time="2000ms"/>\n$2<break strength="x-strong" time="2000ms"/>\n');

  // PARAGRAPH BREAKS
  ssml = ssml.replace(/\n\n+/g, '<break strength="strong" time="1500ms"/>');

  // SENTENCE ENDINGS
  ssml = ssml.replace(/([.!?])(\s+)(?=[A-Z])/g, '$1<break strength="medium" time="800ms"/>$2');

  // COMMA PAUSES
  ssml = ssml.replace(/,(\s+)/g, ',<break time="300ms"/>$1');

  return `<speak>${ssml}</speak>`;
}

async function synthesizeChunk(text, chunkIndex) {
  try {
    if (!text || text.trim().length === 0) {
      console.log(`⏭️  Chunk ${chunkIndex}: Empty, skipping`);
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

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'LBC Blog TTS Render Backend',
    version: '3.1.0',
  });
});

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

    const chunks = splitIntoChunks(content, 2000);
    console.log(`🎙️  Generating ${chunks.length} audio chunks...\n`);

    // Generate chunks IN PARALLEL for speed
    const audioChunks = [];
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

    // Sort to ensure correct order
    audioChunks.sort((a, b) => a.index - b.index);
    // Filter out empty chunks
    const validChunks = audioChunks.filter(c => c.audioBase64);

    console.log(`\n✅ All ${validChunks.length} chunks generated in ${Date.now() - startTime}ms\n`);

    res.json({
      success: true,
      audioChunks: validChunks,
      totalChunks: validChunks.length,
      totalChars: content.length,
      generationTime: Date.now() - startTime,
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
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
    console.log(`\n🚀 LBC Blog TTS Render Backend v3.1 running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 Generate: POST http://localhost:${PORT}/api/blog/generate-audio\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});