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
  origin: ['http://localhost:63055', 'http://localhost:3000', 'https://your-production-domain.com'],
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
  console.log('Firebase initialized successfully at', new Date().toISOString());
} catch (err) {
  console.error('Firebase initialization failed at', new Date().toISOString(), err.message);
  console.error('Invalid JSON content:', process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || 'Undefined');
  process.exit(1);
}

// Initialize Backblaze B2
let b2 = null;
async function initializeB2() {
  try {
    b2 = new B2({
      applicationKeyId: process.env.KEY_ID,
      applicationKey: process.env.APP_KEY,
    });
    await b2.authorize();
    console.log('B2 initialized and authorized at', new Date().toISOString());
  } catch (err) {
    console.error('B2 initialization failed at', new Date().toISOString(), err.message);
    throw err;
  }
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
    console.error('Missing idToken or filePath at', new Date().toISOString(), { idToken: !!idToken, filePath });
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
    console.error(`Error generating signed URL for ${filePath} at`, new Date().toISOString(), err.message, err.stack);
    res.status(500).json({ error: 'Failed to generate signed URL', details: err.message });
  }
});

// Updated upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  console.log('Received upload request at', new Date().toISOString(), {
    headers: req.headers,
    body: req.body,
    file: !!req.file,
  });

  try {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
      console.error('Missing idToken at', new Date().toISOString());
      return res.status(401).json({ error: 'Unauthorized: Missing ID token' });
    }

    console.log('Verifying token at', new Date().toISOString());
    await admin.auth().verifyIdToken(idToken);

    if (!b2) await initializeB2();
    console.log('Backblaze initialized at', new Date().toISOString());

    const { type, courseId, uploader, name = 'Untitled', sectionId = 'default', contentId, duration } = req.body;
    const file = req.file;

    if (!type || !courseId || !uploader || !file || (type !== 'thumbnail' && !contentId)) {
      console.error('Missing required fields at', new Date().toISOString(), { type, courseId, uploader, file: !!file, contentId });
      return res.status(400).json({ error: 'Missing required fields or file' });
    }

    if (!['video', 'pdf', 'thumbnail'].includes(type)) {
      console.error('Invalid file type at', new Date().toISOString(), { type });
      return res.status(400).json({ error: 'Invalid file type' });
    }

    const uuid = uuidv4();
    let filePath;
    if (type === 'video') filePath = `vid_${uuid}.mp4`;
    else if (type === 'pdf') filePath = `pdf_${uuid}.pdf`;
    else filePath = `thumb_${uuid}.jpg`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    console.log('Starting upload simulation for', type, 'at', new Date().toISOString());
    res.write(JSON.stringify({ progress: 0 }) + '\n');

    const totalBytes = file.size;
    const uploadSpeedKBps = 500;
    const estimatedDurationSeconds = totalBytes / (uploadSpeedKBps * 1024);
    let progress = 0;

    const interval = setInterval(() => {
      if (progress < 0.95) {
        progress += 0.02;
        res.write(JSON.stringify({ progress }) + '\n');
      }
    }, 200);

    try {
      const uploadUrlResponse = await b2.getUploadUrl({ bucketId: process.env.BUCKET_ID });
      console.log('Got upload URL at', new Date().toISOString());
      await b2.uploadFile({
        uploadUrl: uploadUrlResponse.data.uploadUrl,
        uploadAuthToken: uploadUrlResponse.data.authorizationToken,
        fileName: filePath,
        data: file.buffer,
      });
      console.log(`${type} uploaded to Backblaze at`, new Date().toISOString());
    } catch (err) {
      console.error('Backblaze upload failed at', new Date().toISOString(), err.message, err.stack);
      throw new Error(`Backblaze upload failed: ${err.message}`);
    } finally {
      clearInterval(interval);
    }

    res.write(JSON.stringify({ progress: 1.0 }) + '\n');

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
          type,
          backblazePath: filePath,
          uploader,
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(type === 'video' && duration ? { duration } : {}),
        };
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
      console.error('Firestore write error at', new Date().toISOString(), err.message, err.stack);
      throw new Error(`Firestore write failed: ${err.message}`);
    }

    const responseData = type === 'thumbnail' ? { thumbnailUrl: filePath } : { fileUrl: filePath };
    res.end(JSON.stringify(responseData) + '\n');
    console.log('Upload completed successfully at', new Date().toISOString(), responseData);
  } catch (err) {
    console.error('Upload error at', new Date().toISOString(), err.message, err.stack);
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
app.listen(port, () => console.log(`Running on port ${port} at`, new Date().toISOString()));