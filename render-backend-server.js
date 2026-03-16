/**
 * LBC Blog TTS - Render Backend (FIXED % AND $)
 * Reads % as "percent" and $ as "dollar" with proper spacing
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

  const sections = text.split(/\n(?=[A-Z][A-Za-z\s]{3,80}(?:\n|$))/);

  for (const section of sections) {
    if (!section.trim()) continue;

    const sentences = section.match(/[^.!?]*[.!?]+/g) || [section];

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      if (current.length + trimmed.length > maxSize && current.length > 0) {
        chunks.push(current.trim());
        current = trimmed;
      } else {
        current += (current ? ' ' : '') + trimmed;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
      current = '';
    }

    chunks.push('[PAUSE_2000ms]');
  }

  if (chunks.length > 0 && chunks[chunks.length - 1] === '[PAUSE_2000ms]') {
    chunks.pop();
  }

  console.log(`📄 Split into ${chunks.length} chunks (including pauses)`);
  return chunks;
}

function textToSSML(text) {
  let ssml = text;

  // REPLACE % with "percent" - add spaces around it
  // Pattern: number % (like "50%")
  ssml = ssml.replace(/(\d+)\%/g, '$1 percent');
  // Pattern: % followed by word (like "%OFF")
  ssml = ssml.replace(/\%([A-Za-z])/g, 'percent $1');
  // Pattern: word followed by % (like "DISCOUNT%")
  ssml = ssml.replace(/([A-Za-z])\%/g, '$1 percent');
  
  // REPLACE $ with "dollar" or "dollars" - add spaces around it
  // Pattern: $number (like "$100")
  ssml = ssml.replace(/\$(\d+)/g, '$1 dollars');
  // Pattern: $ followed by word (like "$OFF")
  ssml = ssml.replace(/\$([A-Za-z])/g, 'dollar $1');
  // Pattern: word followed by $ (like "PRICE$")
  ssml = ssml.replace(/([A-Za-z])\$/g, '$1 dollar');

  // REPLACE # with "number" - add spaces
  // Pattern: #number (like "#1")
  ssml = ssml.replace(/#(\d+)/g, 'number $1');
  // Pattern: # followed by word
  ssml = ssml.replace(/#([A-Za-z])/g, 'number $1');

  // Add spaces between ALL CAPS words (like BLESKIN EXXO)
  ssml = ssml.replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2');
  
  // Add spaces between words and numbers
  ssml = ssml.replace(/([a-z])(\d)/gi, '$1 $2');
  ssml = ssml.replace(/(\d)([a-z])/gi, '$1 $2');

  // NOW: Escape XML special chars
  ssml = ssml.replace(/&/g, '&amp;')
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

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'LBC Blog TTS Render Backend',
    version: '3.3.0',
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

    audioChunks.sort((a, b) => a.index - b.index);
    const validChunks = audioChunks.filter(c => c.audioBase64 || c.audioBase64 === '');

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
    console.log(`\n🚀 LBC Blog TTS Render Backend v3.3 running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 Generate: POST http://localhost:${PORT}/api/blog/generate-audio\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});