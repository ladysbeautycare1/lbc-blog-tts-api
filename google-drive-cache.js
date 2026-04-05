/**
 * Google Drive Cache Module
 * Caches TTS audio files to Google Drive using Domain-Wide Delegation
 * Service account impersonates authorized user to access shared folders
 */

const { google } = require('googleapis');
const crypto = require('crypto');

class GoogleDriveCache {
  constructor(serviceAccountJSON, workspaceUserEmail, driveFolderId) {
    this.serviceAccountJSON = serviceAccountJSON;
    this.workspaceUserEmail = workspaceUserEmail;
    this.driveFolderId = driveFolderId;
    this.drive = null;
    this.memoryCache = new Map(); // 24-hour in-memory cache
    this.cacheTimeout = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Initialize Drive API with Domain-Wide Delegation
   * Service account impersonates the workspace user to access shared folders
   */
  async initialize() {
    try {
      const auth = new google.auth.JWT({
        email: this.serviceAccountJSON.client_email,
        key: this.serviceAccountJSON.private_key,
        scopes: ['https://www.googleapis.com/auth/drive'],
        // Domain-Wide Delegation: impersonate authorized user
        subject: this.workspaceUserEmail,
      });

      this.drive = google.drive({ version: 'v3', auth });
      console.log(`✅ Google Drive Cache initialized (impersonating ${this.workspaceUserEmail})`);
    } catch (error) {
      console.error('❌ Drive cache init error:', error.message);
      throw error;
    }
  }

  /**
   * Generate cache filename from blog content
   * Format: blog_post_[postId]_[contentHash].mp3
   */
  generateCacheFilename(contentHash, postId = null) {
    return `blog_post_${postId || 'unknown'}_${contentHash}.mp3`;
  }

  /**
   * Generate SHA-256 hash of content for unique identification
   */
  generateContentHash(content) {
    return crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')
      .substring(0, 12); // Use first 12 chars for shorter filename
  }

  /**
   * Check if audio file exists in Drive cache
   */
  async getCachedAudio(contentHash, postId = null) {
    try {
      const cacheKey = `${postId}_${contentHash}`;

      // Check memory cache first (fast)
      if (this.memoryCache.has(cacheKey)) {
        const cached = this.memoryCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          console.log(`✅ Cache HIT (memory): ${cacheKey}`);
          return cached.data;
        } else {
          this.memoryCache.delete(cacheKey);
        }
      }

      // Query Drive for file
      const filename = this.generateCacheFilename(contentHash, postId);
      const query = `name='${filename}' and parents='${this.driveFolderId}' and trashed=false`;

      const response = await this.drive.files.list({
        q: query,
        spaces: 'drive',
        fields: 'files(id, name, webContentLink)',
        pageSize: 1,
      });

      if (response.data.files && response.data.files.length > 0) {
        const fileId = response.data.files[0].id;
        console.log(`✅ Cache HIT (Drive): ${filename} (ID: ${fileId})`);

        // Download file content
        const fileContent = await this.drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'arraybuffer' }
        );

        // Store in memory for future access
        this.memoryCache.set(cacheKey, {
          data: fileContent.data,
          timestamp: Date.now(),
        });

        return fileContent.data;
      }

      console.log(`⏭️  Cache MISS: ${filename}`);
      return null;
    } catch (error) {
      console.error(`⚠️  Cache lookup error: ${error.message}`);
      // Don't throw — let it fall through to generate fresh audio
      return null;
    }
  }

  /**
   * Save audio file to Google Drive
   */
  async saveAudioCache(audioBuffer, contentHash, postId = null) {
    try {
      const filename = this.generateCacheFilename(contentHash, postId);
      const cacheKey = `${postId}_${contentHash}`;

      // Check if file already exists to avoid duplicates
      const query = `name='${filename}' and parents='${this.driveFolderId}' and trashed=false`;
      const existing = await this.drive.files.list({
        q: query,
        spaces: 'drive',
        fields: 'files(id)',
        pageSize: 1,
      });

      if (existing.data.files && existing.data.files.length > 0) {
        console.log(`📦 File already cached: ${filename}`);
        return existing.data.files[0].id;
      }

      // Upload new file
      const fileMetadata = {
        name: filename,
        parents: [this.driveFolderId],
        description: `TTS cache - Post ${postId} - ${new Date().toISOString()}`,
      };

      const media = {
        mimeType: 'audio/mpeg',
        body: audioBuffer,
      };

      const response = await this.drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name',
      });

      console.log(`✅ Cached to Drive: ${filename} (ID: ${response.data.id})`);

      // Store in memory cache
      this.memoryCache.set(cacheKey, {
        data: audioBuffer,
        timestamp: Date.now(),
      });

      return response.data.id;
    } catch (error) {
      console.error(`❌ Cache save error: ${error.message}`);
      // Don't throw — caching failure shouldn't break TTS
      return null;
    }
  }

  /**
   * Clean up old cache files (older than 48 hours)
   * Run periodically to save Drive storage
   */
  async cleanupOldCache(maxAgeHours = 48) {
    try {
      const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
      const query = `parents='${this.driveFolderId}' and createdTime<'${cutoffTime.toISOString()}' and trashed=false`;

      const response = await this.drive.files.list({
        q: query,
        spaces: 'drive',
        fields: 'files(id, name, createdTime)',
        pageSize: 100,
      });

      if (response.data.files && response.data.files.length > 0) {
        console.log(`🧹 Cleaning up ${response.data.files.length} old cache files...`);

        for (const file of response.data.files) {
          await this.drive.files.delete({ fileId: file.id });
          console.log(`  ✓ Deleted: ${file.name}`);
        }
      } else {
        console.log(`✅ No old cache files to clean up`);
      }
    } catch (error) {
      console.error(`⚠️  Cleanup error: ${error.message}`);
      // Don't throw — cleanup failure isn't critical
    }
  }

  /**
   * Clear memory cache (useful for testing)
   */
  clearMemoryCache() {
    this.memoryCache.clear();
    console.log('🧹 Memory cache cleared');
  }
}

module.exports = GoogleDriveCache;
