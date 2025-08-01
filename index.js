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
async function getVideoDuration(fileBuffer, originalName) {
  return new Promise((resolve, reject) => {
    const fileExtension = path.extname(originalName).toLowerCase();
    const tempPath = path.join(os.tmpdir(), `temp-${uuidv4()}${fileExtension}`);
    console.log(`Writing temp file for duration extraction: ${tempPath} at`, new Date().toISOString());
    fs.writeFile(tempPath, fileBuffer)
      .then(() => {
        console.log(`Starting ffprobe for ${tempPath} at`, new Date().toISOString());
        ffmpeg.ffprobe(tempPath, (err, metadata) => {
          fs.unlink(tempPath).catch(err => console.error('Failed to delete temp file:', err));
          if (err) {
            console.error('Error extracting video duration:', err.message, err.stack);
            return resolve('00:00'); // Fallback duration
          }
          console.log(`ffprobe metadata for ${tempPath}:`, JSON.stringify(metadata.format, null, 2));
          const durationSeconds = metadata.format.duration;
          if (!durationSeconds || isNaN(durationSeconds)) {
            console.error('No valid duration found in metadata for', tempPath, 'at', new Date().toISOString());
            return resolve('00:00'); // Fallback duration
          }
          const duration = Math.floor(durationSeconds);
          const hours = Math.floor(duration / 3600);
          const minutes = Math.floor((duration % 3600) / 60);
          const seconds = duration % 60;
          const formatted = hours > 0
            ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
            : `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
          console.log(`Extracted duration: ${formatted} for ${tempPath} at`, new Date().toISOString());
          resolve(formatted);
        });
      })
      .catch(err => {
        console.error('Error writing temp file for ffprobe:', err.message, err.stack);
        resolve('00:00'); // Fallback duration
      });
  });
}

// Add String.prototype.padStart for formatting
if (!String.prototype.padStart) {
  String.prototype.padStart = function(length, char) {
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

// Updated upload endpoint with fallback duration
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

    const { type, courseId, uploader, name = 'Untitled', sectionId = 'default', contentId, order } = req.body;
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

    let serverDuration = null;
    if (type === 'video') {
      serverDuration = await getVideoDuration(file.buffer, file.originalname);
      console.log(`Extracted video duration: ${serverDuration} for ${filePath} at`, new Date().toISOString());
      if (!serverDuration || typeof serverDuration !== 'string') {
        console.error('Invalid duration format for', filePath, 'duration:', serverDuration, 'at', new Date().toISOString());
        serverDuration = '00:00'; // Ensure string
      }
    }

    let fileId;
    try {
      const uploadUrlResponse = await b2.getUploadUrl({ bucketId: process.env.BUCKET_ID });
      console.log('Got upload URL at', new Date().toISOString());
      const uploadResponse = await b2.uploadFile({
        uploadUrl: uploadUrlResponse.data.uploadUrl,
        uploadAuthToken: uploadUrlResponse.data.authorizationToken,
        fileName: filePath,
        data: file.buffer,
      });
      fileId = uploadResponse.data.fileId; // Capture fileId for potential cleanup
      console.log(`${type} uploaded to Backblaze at`, new Date().toISOString());
    } catch (err) {
      console.error('Backblaze upload failed at', new Date().toISOString(), err.message, err.stack);
      return res.status(500).json({ error: 'Backblaze upload failed', details: err.message });
    }

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
          ...(order !== undefined ? { order: parseInt(order, 10) } : {}),
          ...(type === 'video' ? { duration: serverDuration } : {}),
        };
        console.log(`Writing to Firestore: courses/${courseId}/sections/${sectionId}/contents/${contentId} with data:`, JSON.stringify(contentData, null, 2));
        await admin.firestore()
          .collection('courses')
          .doc(courseId)
          .collection('sections')
          .doc(sectionId)
          .collection('contents')
          .doc(contentId)
          .set(contentData);
        console.log(`Stored ${type} path ${filePath} with duration ${serverDuration || 'none'} for course ${courseId}, section ${sectionId}, content ${contentId} at`, new Date().toISOString());
      }
    } catch (err) {
      console.error('Firestore write error at', new Date().toISOString(), err.message, err.stack);
      // Clean up Backblaze file on Firestore failure
      if (fileId) {
        try {
          await b2.deleteFileVersion({
            fileName: filePath,
            fileId: fileId,
          });
          console.log(`Deleted Backblaze file ${filePath} due to Firestore failure at`, new Date().toISOString());
        } catch (cleanupErr) {
          console.error('Failed to delete Backblaze file during cleanup at', new Date().toISOString(), cleanupErr.message, cleanupErr.stack);
        }
      }
      return res.status(500).json({ error: 'Firestore write failed', details: err.message });
    }

    const responseData = type === 'thumbnail' ? { thumbnailUrl: filePath } : { fileUrl: filePath };
    if (type === 'video') {
      responseData.duration = serverDuration; // Always include duration for videos
    }
    console.log('Sending response:', JSON.stringify(responseData));
    res.status(200).json(responseData);
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
    const courseData = doc.data();
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