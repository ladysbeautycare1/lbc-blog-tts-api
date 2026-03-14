// =============================================================
// BLOG TTS API — WIF DEBUG FOR RENDER
// =============================================================
// Test which credentials are available in Render environment

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── DEBUG: LOG ALL ENVIRONMENT VARIABLES ─────────────────
app.get('/api/debug/env', (req, res) => {
  const envVars = {
    GOOGLE_PROJECT_ID: process.env.GOOGLE_PROJECT_ID ? '✓ SET' : '✗ MISSING',
    GOOGLE_WORKLOAD_IDENTITY_PROVIDER: process.env.GOOGLE_WORKLOAD_IDENTITY_PROVIDER ? '✓ SET' : '✗ MISSING',
    GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID ? '✓ SET' : '✗ MISSING',
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS ? '✓ SET' : '✗ MISSING',
    GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: process.env.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES ? '✓ SET' : '✗ MISSING',
    RENDER: process.env.RENDER ? '✓ (Running on Render)' : '✗ (Not on Render)',
    NODE_ENV: process.env.NODE_ENV || 'not set'
  };
  
  res.json(envVars);
});

// ─── DEBUG: TEST GOOGLE AUTH ──────────────────────────────
app.get('/api/debug/auth', async (req, res) => {
  try {
    const { GoogleAuth } = require('google-auth-library');
    
    console.log('[DEBUG] Attempting to initialize GoogleAuth...');
    
    const auth = new GoogleAuth({
      projectId: process.env.GOOGLE_PROJECT_ID,
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/texttospeech'
      ]
    });
    
    console.log('[DEBUG] GoogleAuth initialized');
    
    const client = await auth.getClient();
    console.log('[DEBUG] Client obtained');
    
    const projectId = await auth.getProjectId();
    console.log('[DEBUG] Project ID:', projectId);
    
    res.json({
      success: true,
      message: 'Authentication successful',
      projectId: projectId
    });
  } catch (error) {
    console.error('[DEBUG] Auth error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// ─── DEBUG: TEST TTS CLIENT ────────────────────────────────
app.get('/api/debug/tts', async (req, res) => {
  try {
    const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
    
    console.log('[DEBUG] Initializing TextToSpeechClient...');
    
    const client = new TextToSpeechClient({
      projectId: process.env.GOOGLE_PROJECT_ID
    });
    
    console.log('[DEBUG] TextToSpeechClient initialized');
    
    // Test synthesize
    const request = {
      input: { text: 'Test audio generation' },
      voice: {
        languageCode: 'en-AU',
        name: 'en-AU-Neural2-C',
        ssmlGender: 'FEMALE'
      },
      audioConfig: {
        audioEncoding: 'MP3'
      }
    };
    
    console.log('[DEBUG] Calling synthesizeSpeech...');
    const [response] = await client.synthesizeSpeech(request);
    
    console.log('[DEBUG] Audio generated:', response.audioContent.length, 'bytes');
    
    res.json({
      success: true,
      message: 'TTS client working',
      audioSize: response.audioContent.length
    });
  } catch (error) {
    console.error('[DEBUG] TTS error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// ─── DEBUG: TEST DRIVE CLIENT ─────────────────────────────
app.get('/api/debug/drive', async (req, res) => {
  try {
    const { google } = require('googleapis');
    const { GoogleAuth } = require('google-auth-library');
    
    console.log('[DEBUG] Initializing Drive client...');
    
    const auth = new GoogleAuth({
      projectId: process.env.GOOGLE_PROJECT_ID,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    
    const drive = google.drive({
      version: 'v3',
      auth: auth
    });
    
    console.log('[DEBUG] Drive client initialized');
    
    // Test list files
    console.log('[DEBUG] Testing drive.files.list...');
    const response = await drive.files.list({
      q: `"${process.env.GOOGLE_DRIVE_FOLDER_ID}" in parents and trashed=false`,
      spaces: 'drive',
      fields: 'files(id, name)',
      pageSize: 1
    });
    
    console.log('[DEBUG] Drive list successful:', response.data.files.length, 'files found');
    
    res.json({
      success: true,
      message: 'Drive client working',
      filesFound: response.data.files.length
    });
  } catch (error) {
    console.error('[DEBUG] Drive error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/api/blog/health', (req, res) => {
  res.json({ status: 'running', message: 'Use /api/debug/* endpoints to debug WIF' });
});

// ─── ROOT ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'LBC Blog TTS API (DEBUG MODE)',
    debug_endpoints: [
      'GET /api/debug/env - Check environment variables',
      'GET /api/debug/auth - Test GoogleAuth initialization',
      'GET /api/debug/tts - Test TTS client',
      'GET /api/debug/drive - Test Drive client'
    ]
  });
});

// ─── START SERVER ─────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[INFO] Blog TTS API (DEBUG) listening on port ${PORT}`);
  console.log(`[INFO] Visit http://localhost:${PORT}/ for debug endpoints`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;