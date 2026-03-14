// =============================================================
// BLOG TTS API — WORKLOAD IDENTITY FEDERATION
// =============================================================
// Secure Text-to-Speech system with Google Drive caching
// Uses Workload Identity Federation (no JSON keys)
// First read: charges API, repeats: FREE from cache
//
// Environment Variables (set in Render):
//   GOOGLE_PROJECT_ID
//   GOOGLE_WORKLOAD_IDENTITY_PROVIDER
//   GOOGLE_DRIVE_FOLDER_ID
// =============================================================

const express = require("express");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const logger = require("./logger");

const router = express.Router();

// ─── INITIALIZE GOOGLE CLIENTS ────────────────────────────
let ttsClient = null;
let driveClient = null;

async function initializeGoogleClients() {
  if (ttsClient && driveClient) return;

  try {
    // Use Workload Identity Federation
    const auth = new GoogleAuth({
      projectId: process.env.GOOGLE_PROJECT_ID,
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/texttospeech"
      ]
    });

    // TTS Client
    ttsClient = new TextToSpeechClient({
      projectId: process.env.GOOGLE_PROJECT_ID,
      auth: auth
    });

    // Drive Client
    driveClient = google.drive({
      version: "v3",
      auth: auth
    });

    logger.info("✓ Google clients initialized via Workload Identity Federation");
  } catch (error) {
    logger.error("Failed to initialize Google clients", { error: error.message });
    throw error;
  }
}

// ─── FETCH BLOG CONTENT ────────────────────────────────────
async function fetchBlogContent(blogUrl) {
  try {
    const response = await axios.get(blogUrl, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(response.data);
    $("script, style, nav, .sidebar, .comments").remove();

    let content = $("article, .post-content, .entry-content, main").text();
    if (!content) content = $("body").text();

    content = content
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 8000);

    return content.length > 100 ? content : null;
  } catch (error) {
    logger.error("Blog fetch error", { error: error.message });
    return null;
  }
}

// ─── GENERATE CACHE KEY ───────────────────────────────────
function generateCacheKey(blogPostId, content) {
  const hash = crypto
    .createHash("sha256")
    .update(content)
    .digest("hex")
    .substring(0, 8);
  return `lbc-blog-audio-${blogPostId}-${hash}.mp3`;
}

// ─── CHECK IF AUDIO EXISTS IN GOOGLE DRIVE ────────────────
async function findAudioInDrive(cacheKey) {
  try {
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) return null;

    await initializeGoogleClients();

    const response = await driveClient.files.list({
      q: `name="${cacheKey}" and "${folderId}" in parents and trashed=false`,
      spaces: "drive",
      fields: "files(id, name, webContentLink)",
      pageSize: 1,
    });

    if (response.data.files && response.data.files.length > 0) {
      const file = response.data.files[0];
      logger.info("✓ Found cached audio in Drive", { fileName: cacheKey });
      return {
        fileId: file.id,
        fileName: file.name,
        downloadLink: file.webContentLink,
      };
    }

    return null;
  } catch (error) {
    logger.error("Drive search error", { error: error.message });
    return null;
  }
}

// ─── SYNTHESIZE SPEECH VIA GOOGLE TTS ──────────────────────
async function synthesizeSpeech(text) {
  try {
    await initializeGoogleClients();

    const request = {
      input: { text: text },
      voice: {
        languageCode: "en-AU",
        name: "en-AU-Neural2-C",
        ssmlGender: "FEMALE",
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: 0.95,
        pitch: 0.0,
        volumeGainDb: 0.0,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);

    if (!response.audioContent) {
      throw new Error("No audio content returned");
    }

    logger.info("✓ Audio synthesized", { contentLength: response.audioContent.length });
    return response.audioContent;

  } catch (error) {
    logger.error("TTS synthesis error", { error: error.message });
    throw error;
  }
}

// ─── UPLOAD AUDIO TO GOOGLE DRIVE ─────────────────────────
async function uploadAudioToDrive(cacheKey, audioBuffer) {
  try {
    await initializeGoogleClients();

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      throw new Error("GOOGLE_DRIVE_FOLDER_ID not set");
    }

    const file = {
      name: cacheKey,
      parents: [folderId],
      description: `LBC Blog Audio - ${new Date().toISOString()}`,
    };

    const response = await driveClient.files.create({
      resource: file,
      media: {
        mimeType: "audio/mpeg",
        body: audioBuffer,
      },
      fields: "id, webContentLink",
    });

    logger.info("✓ Audio uploaded to Drive", { fileId: response.data.id });

    return {
      fileId: response.data.id,
      fileName: cacheKey,
      downloadLink: response.data.webContentLink,
    };

  } catch (error) {
    logger.error("Drive upload error", { error: error.message });
    throw error;
  }
}

// ─── MAIN ENDPOINT: READ BLOG ALOUD ────────────────────────
router.post("/api/blog/read-aloud", async (req, res) => {
  try {
    const { blogPostId, blogUrl, blogContent } = req.body;

    if (!blogPostId || (!blogUrl && !blogContent)) {
      return res.status(400).json({
        error: "Missing blogPostId and (blogUrl or blogContent)"
      });
    }

    let content = blogContent;
    if (!content && blogUrl) {
      content = await fetchBlogContent(blogUrl);
      if (!content) {
        return res.status(400).json({
          error: "Could not fetch blog content"
        });
      }
    }

    const cacheKey = generateCacheKey(blogPostId, content);

    // Check cache first
    const cachedAudio = await findAudioInDrive(cacheKey);
    if (cachedAudio) {
      return res.json({
        success: true,
        cached: true,
        audioUrl: cachedAudio.downloadLink,
        fileId: cachedAudio.fileId,
        message: "Cached audio (no API charge)"
      });
    }

    // Generate new audio
    const audioBuffer = await synthesizeSpeech(content);

    // Upload to Drive for caching
    const uploadedFile = await uploadAudioToDrive(cacheKey, audioBuffer);

    return res.json({
      success: true,
      cached: false,
      audioUrl: uploadedFile.downloadLink,
      fileId: uploadedFile.fileId,
      message: "New audio generated and cached"
    });

  } catch (error) {
    logger.error("Read aloud endpoint error", { error: error.message });
    return res.status(500).json({
      error: "Failed to generate audio",
      message: error.message
    });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
router.get("/api/blog/health", (req, res) => {
  res.json({ status: "TTS system ready" });
});

module.exports = router;
