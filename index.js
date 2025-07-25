require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const B2 = require('backblaze-b2');

const app = express();

// Configure CORS for Flutter web app
app.use(cors({
  origin: ['http://localhost:57420', 'https://b2-backend-production.up.railway.app'], // Update with your production domain
  methods: ['GET'],
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
  console.error('Invalid JSON content:', process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  process.exit(1);
}

// Initialize Backblaze B2
const b2 = new B2({
  applicationKeyId: process.env.KEY_ID,
  applicationKey: process.env.APP_KEY,
});

// Endpoint to generate signed URL for Backblaze files
app.get('/file-url', async (req, res) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  const filePath = req.query.file;

  if (!idToken || !filePath) {
    return res.status(400).json({ error: 'Missing idToken or filePath' });
  }

  try {
    // Verify Firebase ID token
    await admin.auth().verifyIdToken(idToken);

    // Authorize Backblaze
    await b2.authorize();

    // Generate signed URL
    const response = await b2.getDownloadAuthorization({
      bucketId: process.env.BUCKET_ID,
      fileNamePrefix: filePath,
      validDurationInSeconds: 3600, // URL valid for 1 hour
    });

    const signedUrl = `${response.data.downloadUrl}/file/${process.env.BUCKET_NAME}/${filePath}?Authorization=${response.data.authorizationToken}`;
    res.json({ url: signedUrl });
  } catch (err) {
    console.error('Error generating signed URL:', err.message);
    res.status(500).json({ error: 'Failed to generate signed URL', details: err.message });
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
