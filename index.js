require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const BackblazeB2 = require('backblaze-b2');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

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
    b2 = new BackblazeB2({
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

// Video duration extraction
async function getVideoDuration(fileBuffer) {
  return new Promise((resolve, reject) => {
    const tempPath = path.join(os.tmpdir(), `temp-${uuidv4()}.mp4`);
    fs.writeFile(tempPath, fileBuffer)
      .then(() => {
        ffmpeg.ffprobe(tempPath, (err, metadata) => {
          fs.unlink(tempPath).catch(err => console.error('Failed to delete temp file:', err));
          if (err) {
            console.error('Error extracting video duration:', err);
            return reject(err);
          }
          const durationSeconds = metadata.format.duration;
          if (!durationSeconds) {
            return reject(new Error('Could not extract video duration'));
          }
          const duration = Math.floor(durationSeconds);
          const hours = Math.floor(duration / 3600);
          const minutes = Math.floor((duration % 3600) / 60);
          const seconds = duration % 60;
          const formatted = hours > 0
            ? `${hours.toString().padLeft(2, '0')}:${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}`
            : `${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}`;
          resolve(formatted);
        });
      })
      .catch(err => {
        console.error('Error writing temp file for ffprobe:', err);
        reject(err);
      });
  });
}

// Add String.prototype.padLeft for formatting
if (!String.prototype.padLeft) {
  String.prototype.padLeft = function(length, char) {
    return char.repeat(Math.max(0, length - this.length)) + this;
  };
}

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

// Updated upload endpoint with duration extraction
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
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const userId = decodedToken.uid;

    if (!b2) await initializeB2();
    console.log('Backblaze initialized at', new Date().toISOString());

    const { type, courseId, uploader, name = 'Untitled', sectionId = 'default', contentId, duration: clientDuration } = req.body;
    const file = req.file;

    if (!type || !courseId || !uploader || !file || (type !== 'thumbnail' && !contentId)) {
      console.error('Missing required fields at', new Date().toISOString(), { type, courseId, uploader, file: !!file, contentId });
      return res.status(400).json({ error: 'Missing required fields or file' });
    }

    if (uploader !== userId) {
      console.error('Uploader does not match authenticated user at', new Date().toISOString(), { uploader, userId });
      return res.status(403).json({ error: 'Forbidden', details: 'Uploader does not match authenticated user' });
    }

    if (!['video', 'pdf', 'thumbnail'].includes(type)) {
      console.error('Invalid file type at', new Date().toISOString(), { type });
      return res.status(400).json({ error: 'Invalid file type' });
    }

    const uuid = uuidv4();
    let filePath;
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (type === 'video') {
      if (!['.mp4', '.mov', '.avi'].includes(fileExtension)) {
        console.error('Invalid video format at', new Date().toISOString(), { fileExtension });
        return res.status(400).json({ error: 'Invalid video format', details: 'Only MP4, MOV, or AVI allowed' });
      }
      filePath = `videos/vid_${uuid}${fileExtension}`;
    } else if (type === 'pdf') {
      if (fileExtension !== '.pdf') {
        console.error('Invalid PDF format at', new Date().toISOString(), { fileExtension });
        return res.status(400).json({ error: 'Invalid file format', details: 'Only PDF allowed' });
      }
      filePath = `pdfs/pdf_${uuid}${fileExtension}`;
    } else {
      if (!['.jpg', '.jpeg', '.png'].includes(fileExtension)) {
        console.error('Invalid thumbnail format at', new Date().toISOString(), { fileExtension });
        return res.status(400).json({ error: 'Invalid thumbnail format', details: 'Only JPG or PNG allowed' });
      }
      filePath = `thumbnails/thumb_${uuid}${fileExtension}`;
    }

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

    let serverDuration = clientDuration;
    if (type === 'video' && !clientDuration) {
      try {
        serverDuration = await getVideoDuration(file.buffer);
        console.log(`Extracted video duration: ${serverDuration} at`, new Date().toISOString());
      } catch (err) {
        console.error('Failed to extract video duration at', new Date().toISOString(), err.message);
      }
    }

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
          ...(type === 'video' && serverDuration ? { duration: serverDuration } : {}),
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
    if (type === 'video' && serverDuration) {
      responseData.duration = serverDuration;
    }
    res.end(JSON.stringify(responseData) + '\n');
    console.log('Upload completed successfully at', new Date().toISOString(), responseData);
  } catch (err) {
    console.error('Upload error at', new Date().toISOString(), err.message, err.stack);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// Fetch all courses
app.get('/courses', async (req, res) => {
  try {
    const snapshot = await admin.firestore().collection('courses').get();
    const courses = [];
    for (const doc of snapshot.docs) {
      const courseData = doc.data();
      const sectionsSnapshot = await admin.firestore().collection('courses').doc(doc.id).collection('sections').get();
      const sections = await Promise.all(
        sectionsSnapshot.docs.map(async (sectionDoc) => {
          const contentsSnapshot = await admin.firestore()
            .collection('courses')
            .doc(doc.id)
            .collection('sections')
            .doc(sectionDoc.id)
            .collection('contents')
            .get();
          const contents = contentsSnapshot.docs.map((contentDoc) => ({
            id: contentDoc.id,
            ...contentDoc.data(),
          }));
          return {
            id: sectionDoc.id,
            ...sectionDoc.data(),
            contents,
          };
        })
      );
      courses.push({
        id: doc.id,
        ...courseData,
        sections,
      });
    }
    res.json(courses);
  } catch (error) {
    console.error('Error fetching courses at', new Date().toISOString(), error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch courses', details: error.message });
  }
});

// Fetch course by ID
app.get('/course/:id', async (req, res) => {
  try {
    const courseId = req.params.id;
    const courseDoc = await admin.firestore().collection('courses').doc(courseId).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ error: 'Course not found' });
    }
    const courseData = courseDoc.data();
    const sectionsSnapshot = await admin.firestore().collection('courses').doc(courseId).collection('sections').get();
    const sections = await Promise.all(
      sectionsSnapshot.docs.map(async (sectionDoc) => {
        const contentsSnapshot = await admin.firestore()
          .collection('courses')
          .doc(courseId)
          .collection('sections')
          .doc(sectionDoc.id)
          .collection('contents')
          .get();
        const contents = contentsSnapshot.docs.map((contentDoc) => ({
          id: contentDoc.id,
          ...contentDoc.data(),
        }));
        return {
          id: sectionDoc.id,
          ...sectionDoc.data(),
          contents,
        };
      })
    );
    res.json({
      id: courseId,
      ...courseData,
      sections,
    });
  } catch (error) {
    console.error('Error fetching course at', new Date().toISOString(), error.message, error.stack);
    res.status(500).json({ error: 'Failed to fetch course', details: error.message });
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