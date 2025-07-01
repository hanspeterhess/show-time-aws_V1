const express = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const streamToString = require('./streamToString'); // helper to read S3 stream

const app = express();
app.use(express.json());

const s3 = new S3Client({ region: "eu-central-1" });
const BUCKET_NAME = process.env.S3_BUCKET;

app.post('/time', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const key = 'current-time.json';
    const body = JSON.stringify({ time: now });

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    }));

    res.json({ message: 'Time saved', time: now });
  } catch (err) {
    console.error('Error saving time:', err);
    res.status(500).json({ error: 'Failed to save time' });
  }
});

app.get('/time', async (req, res) => {
  try {
    const key = 'current-time.json';

    const data = await s3.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }));

    const bodyContents = await streamToString(data.Body);
    const json = JSON.parse(bodyContents);
    res.json(json);
  } catch (err) {
    console.error('Error getting time:', err);
    res.status(500).json({ error: 'Failed to get time' });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));

