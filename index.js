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

// Initialize Backblaze B2
const b2 = new B2({
  applicationKeyId: process.env.KEY_ID,
  applicationKey: process.env.APP_KEY,
});

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
    console.log(`Verified token for file: ${filePath}`);

    // Authorize Backblaze
    const authResponse = await b2.authorize();
    console.log('Backblaze auth response:', JSON.stringify(authResponse.data, null, 2));

    // Generate signed URL
    const response = await b2.getDownloadAuthorization({
      bucketId: process.env.BUCKET_ID,
      fileNamePrefix: filePath,
      validDurationInSeconds: 3600, // URL valid for 1 hour
    });

    console.log('Backblaze download auth response:', JSON.stringify(response.data, null, 2));

    // Fallback to account's downloadUrl or default endpoint
    const downloadUrl = response.data.downloadUrl || authResponse.data.downloadUrl || `https://f000.backblazeb2.com`;
    const signedUrl = `${downloadUrl}/file/${process.env.BUCKET_NAME}/${filePath}?Authorization=${response.data.authorizationToken}`;
    console.log(`Generated signed URL: ${signedUrl}`);

    res.json({ url: signedUrl });
  } catch (err) {
    console.error(`Error generating signed URL for ${filePath}:`, err.message, err);
    res.status(500).json({ error: 'Failed to generate signed URL', details: err.message });
  }
});

// New endpoint to handle file uploads
app.post('/upload', upload.fields([{ name: 'video' }, { name: 'thumbnail' }]), async (req, res) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  if (!idToken) {
    console.error('Missing idToken');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Verify Firebase ID token
    await admin.auth().verifyIdToken(idToken);
    console.log('Verified token for upload');

    // Authorize Backblaze
    await b2.authorize();

    const uuid = uuidv4();
    const videoFile = req.files['video'][0];
    const thumbnailFile = req.files['thumbnail'][0];
    const videoPath = `vid_${uuid}.mp4`;
    const thumbnailPath = `thumb_${uuid}.jpg`;
    const name = req.body.name;
    const price = req.body.price;
    const description = req.body.description;

    if (!videoFile || !thumbnailFile || !name || !price || !description) {
      console.error('Missing required fields or files:', { videoFile: !!videoFile, thumbnailFile: !!thumbnailFile, name, price, description });
      return res.status(400).json({ error: 'Missing required fields or files' });
    }

    // Upload video to Backblaze
    const videoUploadResponse = await b2.getUploadUrl({ bucketId: process.env.BUCKET_ID });
    await b2.uploadFile({
      uploadUrl: videoUploadResponse.data.uploadUrl,
      uploadAuthToken: videoUploadResponse.data.authorizationToken,
      fileName: videoPath,
      data: videoFile.buffer,
    });

    // Upload thumbnail to Backblaze
    const thumbnailUploadResponse = await b2.getUploadUrl({ bucketId: process.env.BUCKET_ID });
    await b2.uploadFile({
      uploadUrl: thumbnailUploadResponse.data.uploadUrl,
      uploadAuthToken: thumbnailUploadResponse.data.authorizationToken,
      fileName: thumbnailPath,
      data: thumbnailFile.buffer,
    });

    // Generate download URLs (simplified; adjust based on your needs)
    const downloadUrl = `https://f000.backblazeb2.com/file/${process.env.BUCKET_NAME}`;
    const videoUrl = `${downloadUrl}/${videoPath}`;
    const thumbnailUrl = `${downloadUrl}/${thumbnailPath}`;

    console.log(`Uploaded video: ${videoUrl}, thumbnail: ${thumbnailUrl}`);

    res.json({
      videoUrl: videoUrl,
      thumbnailUrl: thumbnailUrl,
    });
  } catch (err) {
    console.error('Upload error:', err.message, err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
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
app.listen(port, () => console.log(`Running on port ${port}`));