require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid'); // For generating UUIDs

const app = express();

// Configure CORS for Flutter web app
app.use(cors({
  origin: ['http://localhost:63055', 'https://your-production-domain.com'], // Update with your production domain
  methods: ['GET', 'POST'], // Allow POST for upload
  allowedHeaders: ['Authorization', 'Content-Type'],
}));
app.use(express.json());

// Initialize Firebase Admin
try {
  console.log('GOOGLE_APPLICATION_CREDENTIALS_JSON length:', process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.length || 'Undefined');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not set');
  }
  const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('Firebase initialized successfully');
} catch (err) {
  console.error('Firebase initialization failed:', err.message);
  console.error('Invalid JSON content:', process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || 'Undefined');
  process.exit(1);
}

// Initialize Backblaze B2 globally to avoid per-request authorization
let b2 = null;
async function initializeB2() {
  b2 = new B2({
    applicationKeyId: process.env.KEY_ID,
    applicationKey: process.env.APP_KEY,
  });
  await b2.authorize();
  console.log('B2 initialized and authorized at', new Date().toISOString());
}
initializeB2().catch(err => console.error('B2 initialization failed:', err));

// Configure multer for file uploads
const storage = multer.memoryStorage(); // Store files in memory for upload
const upload = multer({ storage: storage });

// Endpoint to generate signed URL for Backblaze files
app.get('/file-url', async (req, res) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  const filePath = req.query.file;

  if (!idToken || !filePath) {
    console.error('Missing idToken or filePath:', { idToken: !!idToken, filePath });
    return res.status(400).json({ error: 'Missing idToken or filePath' });
  }

  try {
    // Verify Firebase ID token
    await admin.auth().verifyIdToken(idToken);
    console.log(`Verified token for file: ${filePath} at`, new Date().toISOString());

    // Authorize Backblaze (re-authorize if needed, but should be cached)
    if (!b2) await initializeB2();
    const authResponse = await b2.authorize();
    console.log('Backblaze auth response at:', new Date().toISOString(), JSON.stringify(authResponse.data, null, 2));

    // Generate signed URL
    const response = await b2.getDownloadAuthorization({
      bucketId: process.env.BUCKET_ID,
      fileNamePrefix: filePath,
      validDurationInSeconds: 3600, // URL valid for 1 hour
    });

    console.log('Backblaze download auth response at:', new Date().toISOString(), JSON.stringify(response.data, null, 2));

    // Fallback to account's downloadUrl or default endpoint
    const downloadUrl = response.data.downloadUrl || authResponse.data.downloadUrl || `https://f000.backblazeb2.com`;
    const signedUrl = `${downloadUrl}/file/${process.env.BUCKET_NAME}/${filePath}?Authorization=${response.data.authorizationToken}`;
    console.log(`Generated signed URL: ${signedUrl} at`, new Date().toISOString());

    res.json({ url: signedUrl });
  } catch (err) {
    console.error(`Error generating signed URL for ${filePath} at`, new Date().toISOString(), err.message, err);
    res.status(500).json({ error: 'Failed to generate signed URL', details: err.message });
  }
});

// New endpoint to handle file uploads with progress streaming
app.post('/upload', upload.fields([{ name: 'video' }, { name: 'thumbnail' }]), async (req, res) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  if (!idToken) {
    console.error('Missing idToken at', new Date().toISOString());
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Upload request received at', new Date().toISOString());
    // Verify Firebase ID token
    await admin.auth().verifyIdToken(idToken);
    console.log('Token verified at', new Date().toISOString());

    // Ensure B2 is initialized
    if (!b2) await initializeB2();

    const uuid = uuidv4();
    const videoFile = req.files['video'][0];
    const thumbnailFile = req.files['thumbnail'][0];
    const videoPath = `vid_${uuid}.mp4`;
    const thumbnailPath = `thumb_${uuid}.jpg`;
    const name = req.body.name;
    const price = req.body.price;
    const description = req.body.description;

    if (!videoFile || !thumbnailFile || !name || !price || !description) {
      console.error('Missing required fields or files at', new Date().toISOString(), { videoFile: !!videoFile, thumbnailFile: !!thumbnailFile, name, price, description });
      return res.status(400).json({ error: 'Missing required fields or files' });
    }

    // Set response to chunked encoding
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    console.log('Response headers set at', new Date().toISOString());

    // Upload video with estimated progress
    const videoTotalBytes = videoFile.size;
    const uploadSpeedKBps = 500; // Adjustable, e.g., 500 KB/s
    const estimatedDurationSeconds = videoTotalBytes / (uploadSpeedKBps * 1024); // Seconds
    let videoProgress = 0;
    res.write(JSON.stringify({ progress: 0 }) + '\n'); // Initial progress
    console.log('Video upload started at', new Date().toISOString());
    const videoInterval = setInterval(() => {
      if (videoProgress < 0.5) {
        videoProgress += 0.02; // 2% increments
        if (videoProgress > 0.5) videoProgress = 0.5;
        res.write(JSON.stringify({ progress: videoProgress }) + '\n');
      }
    }, 200); // Update every 200ms

    const videoUploadResponse = await b2.getUploadUrl({ bucketId: process.env.BUCKET_ID });
    await b2.uploadFile({
      uploadUrl: videoUploadResponse.data.uploadUrl,
      uploadAuthToken: videoUploadResponse.data.authorizationToken,
      fileName: videoPath,
      data: videoFile.buffer,
    });
    clearInterval(videoInterval);
    res.write(JSON.stringify({ progress: 0.5 }) + '\n'); // Confirm 50% on completion
    console.log('Video upload completed at', new Date().toISOString());

    // Upload thumbnail with estimated progress
    const thumbnailTotalBytes = thumbnailFile.size;
    const estimatedThumbnailDurationSeconds = thumbnailTotalBytes / (uploadSpeedKBps * 1024); // Seconds
    let thumbnailProgress = 0.5;
    const thumbnailInterval = setInterval(() => {
      if (thumbnailProgress < 1.0) {
        thumbnailProgress += 0.02; // 2% increments
        if (thumbnailProgress > 1.0) thumbnailProgress = 1.0;
        res.write(JSON.stringify({ progress: thumbnailProgress }) + '\n');
      }
    }, 200); // Update every 200ms

    const thumbnailUploadResponse = await b2.getUploadUrl({ bucketId: process.env.BUCKET_ID });
    await b2.uploadFile({
      uploadUrl: thumbnailUploadResponse.data.uploadUrl,
      uploadAuthToken: thumbnailUploadResponse.data.authorizationToken,
      fileName: thumbnailPath,
      data: thumbnailFile.buffer,
    });
    clearInterval(thumbnailInterval);
    res.write(JSON.stringify({ progress: 1.0 }) + '\n'); // Confirm 100% on completion
    console.log('Thumbnail upload completed at', new Date().toISOString());

    // Ensure final response is complete
    try {
      res.end(JSON.stringify({
        videoUrl: videoPath,
        thumbnailUrl: thumbnailPath,
      }) + '\n'); // Add newline for consistency
      console.log('Final response sent at', new Date().toISOString());
    } catch (err) {
      console.error('Final response error at', new Date().toISOString(), err);
      res.status(500).end(JSON.stringify({ error: 'Failed to send final response', details: err.message }) + '\n');
    }
  } catch (err) {
    console.error('Upload error at', new Date().toISOString(), err.message, err.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Upload failed', details: err.message });
    } else {
      res.status(500).end(JSON.stringify({ error: 'Upload failed', details: err.message }) + '\n');
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'Server is running',
    env: {
      KEY_ID: !!process.env.KEY_ID,
      APP_KEY: !!process.env.APP_KEY,
      BUCKET_NAME: process.env.BUCKET_NAME,
      BUCKET_ID: process.env.BUCKET_ID,
      GOOGLE_APPLICATION_CREDENTIALS_JSON: !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    },
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running on port ${port} at`, new Date().toISOString()));