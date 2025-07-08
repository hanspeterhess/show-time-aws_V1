const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");

require('dotenv').config();

// Configure AWS SDK region
AWS.config.update({ region: process.env.AWS_REGION});
const tableName = process.env.TABLE_NAME;
const bucketName = process.env.BUCKET_NAME;
const PORT = process.env.PORT || 4000;

if (!bucketName) {
  console.error("Missing BUCKET_NAME environment variable");
}

app.use(cors());
app.use(bodyParser.json());

// Simple health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running" });
});

const dynamoDb = new AWS.DynamoDB.DocumentClient();


app.get("/upload-url", (req, res) => {
  const s3 = new AWS.S3();
  const fileName = `${uuidv4()}.jpg`; // or .png/.webp

  const params = {
    Bucket: bucketName,
    Key: fileName,
    Expires: 60,
    ContentType: "image/jpeg", // match expected upload type
  };

  s3.getSignedUrl("putObject", params, (err, url) => {
    if (err) {
      console.error("❌ S3 Signed URL error:", err);
      return res.status(500).json({ error: "Failed to create signed URL" });
    }
    console.log("✅ Generated S3 signed URL:", { fileName, url });
    res.json({ uploadUrl: url, fileName });
  });
});


app.post("/store-time", async (req, res) => {
  const time = new Date().toISOString();
  const id = uuidv4();

  const params = {
    TableName: tableName,
    Item: {
      id,
      timestamp: time,
    },
  };

  try {
    await dynamoDb.put(params).promise();
    console.log("✅ Stored in DynamoDB:", params.Item);
  } catch (err) {
    console.error("❌ DynamoDB Error:", err);
    return res.status(500).json({ error: "Failed to save to DynamoDB" });
  }

  setTimeout(() => {
    io.emit("time-ready", { time });
  }, 5000);

  res.json({ status: "ok", time });
});



server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

// app._router.stack.forEach(r => {
//   if (r.route && r.route.path) {
//     console.log("Registered route:", r.route.path);
//   }
// });