/**
 * LBC Blog TTS - Render Backend (Optimized Streaming)
 * Generates and returns audio chunks immediately as they're ready
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

  // FIRST: Split on major sections (titles/subtitles followed by content)
  // Detect lines that are titles/subtitles (short, all caps or title case at start of line)
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

    // ADD A PAUSE BETWEEN SECTIONS (empty chunk creates 2 second gap)
    // This forces the frontend to pause between title/subtitle and content
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // TITLE BREAKS - Add strong pause before titles (short lines at start or after paragraphs)
  ssml = ssml.replace(/^([A-Z][A-Za-z0-9\s]{5,60})(\n+)/gm, '<break strength="x-strong" time="1500ms"/>$1<break strength="strong" time="1000ms"/>\n');

  // SUBTITLE BREAKS - Add pause before subtitles (indented or after title)
  ssml = ssml.replace(/\n([A-Z][A-Za-z0-9\s]{5,60})(\n+)/gm, '\n<break strength="strong" time="1200ms"/>$1<break strength="medium" time="800ms"/>\n');

  // PARAGRAPH BREAKS - Long pause between paragraphs
  ssml = ssml.replace(/\n\n+/g, '<break strength="strong" time="1500ms"/>');

  // BULLET POINT BREAKS - Pause before bullet points
  ssml = ssml.replace(/\n([-•*])/g, '<break strength="strong" time="1000ms"/>\n$1');

  // BULLET POINT END BREAKS - Pause after each bullet point
  ssml = ssml.replace(/([-•*][^\n]+)\n/g, '$1<break strength="medium" time="800ms"/>\n');

  // COLON BREAKS - Medium pause after colons (before lists/explanations)
  ssml = ssml.replace(/(:)(\s+)/g, '$1<break strength="medium" time="800ms"/>$2');

  // SENTENCE ENDINGS - Pause AFTER period, exclamation, question mark
  ssml = ssml.replace(/([.!?])(\s+)(?=[A-Z])/g, '$1<break strength="medium" time="800ms"/>$2');
  ssml = ssml.replace(/([.!?])(\s+)(?=[a-z])/g, '$1<break time="400ms"/>$2');

  // COMMA PAUSES - Slight pause at commas
  ssml = ssml.replace(/,(\s+)/g, ',<break time="250ms"/>$1');

  // SEMICOLON PAUSES - Medium pause
  ssml = ssml.replace(/;(\s+)/g, ';<break strength="medium" time="600ms"/>$1');

  return `<speak>${ssml}</speak>`;
}


async function synthesizeChunk(text, chunkIndex) {
  try {
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
    version: '3.0.0',
  });
});

// OPTIMIZED: Generate audio endpoint with streaming response
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

    // OPTIMIZATION: Generate chunks in PARALLEL (not sequential)
    const audioChunks = [];
    const synthPromises = chunks.map((chunk, index) =>
      synthesizeChunk(chunk, index)
        .then(audioBuffer => {
          audioChunks[index] = {
            index: index,
            audioBase64: audioBuffer.toString('base64'),
            textLength: chunk.length,
          };
          console.log(`✅ Chunk ${index + 1}/${chunks.length} ready`);
        })
        .catch(error => {
          console.error(`❌ Chunk ${index} failed:`, error.message);
          throw error;
        })
    );

    // Wait for all chunks in parallel
    await Promise.all(synthPromises);

    // Sort to ensure correct order (in case they finish out of order)
    audioChunks.sort((a, b) => a.index - b.index);

    console.log(`\n✅ All ${audioChunks.length} chunks generated in ${Date.now() - startTime}ms\n`);

    res.json({
      success: true,
      audioChunks: audioChunks,
      totalChunks: audioChunks.length,
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
    console.log(`\n🚀 LBC Blog TTS Render Backend v3.0 running on port ${PORT}`);
    console.log(`📍 Health: http://localhost:${PORT}/health`);
    console.log(`📍 Generate: POST http://localhost:${PORT}/api/blog/generate-audio\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});