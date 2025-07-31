require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Configure CORS for Flutter web app
app.use(cors({
  origin: ['http://localhost:63055', 'https://your-production-domain.com'],
  methods: ['GET', 'POST'],
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
const storage = multer.memoryStorage();
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
    await admin.auth().verifyIdToken(idToken);
    console.log(`Verified token for file: ${filePath} at`, new Date().toISOString());

    if (!b2) await initializeB2();
    const authResponse = await b2.authorize();
    const response = await b2.getDownloadAuthorization({
      bucketId: process.env.BUCKET_ID,
      fileNamePrefix: filePath,
      validDurationInSeconds: 3600,
    });

    const downloadUrl = response.data.downloadUrl || authResponse.data.downloadUrl || `https://f000.backblazeb2.com`;
    const signedUrl = `${downloadUrl}/file/${process.env.BUCKET_NAME}/${filePath}?Authorization=${response.data.authorizationToken}`;
    console.log(`Generated signed URL: ${signedUrl} at`, new Date().toISOString());

    res.json({ url: signedUrl });
  } catch (err) {
    console.error(`Error generating signed URL for ${filePath} at`, new Date().toISOString(), err.message, err);
    res.status(500).json({ error: 'Failed to generate signed URL', details: err.message });
  }
});

// Updated upload endpoint to handle single file with type
app.post('/upload', upload.single('file'), async (req, res) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  if (!idToken) {
    console.error('Missing idToken at', new Date().toISOString());
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('Upload request received at', new Date().toISOString());
    await admin.auth().verifyIdToken(idToken);
    console.log('Token verified at', new Date().toISOString());

    if (!b2) await initializeB2();

    const type = req.body.type; // 'video', 'pdf', or 'thumbnail'
    const courseId = req.body.courseId;
    const uploader = req.body.uploader;
    const name = req.body.name || 'Untitled';
    const description = req.body.description || 'No description';
    const sectionId = req.body.sectionId || 'default';
    const contentId = req.body.contentId;
    const duration = req.body.duration;
    const file = req.file;

    if (!type || !courseId || !uploader || !file || (type !== 'thumbnail' && !contentId)) {
      console.error('Missing required fields or file at', new Date().toISOString(), {
        type,
        courseId,
        uploader,
        file: !!file,
        contentId,
      });
      return res.status(400).json({ error: 'Missing required fields or file' });
    }

    const uuid = uuidv4();
    let filePath;
    if (type === 'video') {
      filePath = `vid_${uuid}.mp4`;
    } else if (type === 'pdf') {
      filePath = `pdf_${uuid}.pdf`;
    } else if (type === 'thumbnail') {
      filePath = `thumb_${uuid}.jpg`;
    } else {
      console.error('Invalid file type:', type);
      return res.status(400).json({ error: 'Invalid file type' });
    }

    // Set response to chunked encoding
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    console.log('Response headers set at', new Date().toISOString());

    // Upload file with progress
    const totalBytes = file.size;
    const uploadSpeedKBps = 500; // Adjustable
    const estimatedDurationSeconds = totalBytes / (uploadSpeedKBps * 1024);
    let progress = 0;
    res.write(JSON.stringify({ progress: 0 }) + '\n');
    console.log(`${type} upload started at`, new Date().toISOString());

    const interval = setInterval(() => {
      if (progress < 0.95) {
        progress += 0.02;
        if (progress > 0.95) progress = 0.95;
        res.write(JSON.stringify({ progress }) + '\n');
      }
    }, 200);

    const uploadUrlResponse = await b2.getUploadUrl({ bucketId: process.env.BUCKET_ID });
    await b2.uploadFile({
      uploadUrl: uploadUrlResponse.data.uploadUrl,
      uploadAuthToken: uploadUrlResponse.data.authorizationToken,
      fileName: filePath,
      data: file.buffer,
    });
    clearInterval(interval);
    res.write(JSON.stringify({ progress: 1.0 }) + '\n');
    console.log(`${type} upload completed at`, new Date().toISOString());

    // Store in Firestore
    try {
      if (type === 'thumbnail') {
        await admin.firestore().collection('courses').doc(courseId).update({
          thumbnailUrl: filePath,
          videoLastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`Stored thumbnail path ${filePath} for course ${courseId} at`, new Date().toISOString());
      } else {
        const contentData = {
          title: name,
          type: type,
          backblazePath: filePath,
          description: description,
          uploader: uploader,
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (type === 'video' && duration) contentData.duration = duration;

        await admin.firestore()
          .collection('courses')
          .doc(courseId)
          .collection('sections')
          .doc(sectionId)
          .collection('contents')
          .doc(contentId)
          .set(contentData);
        console.log(`Stored ${type} path ${filePath} for course ${courseId}, section ${sectionId}, content ${contentId} at`, new Date().toISOString());
      }
    } catch (err) {
      console.error('Firestore write error at', new Date().toISOString(), err.message);
      throw err;
    }

    // Send final response
    try {
      const responseData = type === 'thumbnail' ? { thumbnailUrl: filePath } : { fileUrl: filePath };
      res.end(JSON.stringify(responseData) + '\n');
      console.log('Final response sent at', new Date().toISOString(), responseData);
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