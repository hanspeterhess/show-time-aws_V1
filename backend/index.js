const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = express();
const server = http.createServer(app);
const AWS = require("aws-sdk"); 
const { v4: uuidv4 } = require("uuid");
const fs = require('fs').promises; // Import Node.js file system module
const path = require('path'); // Import path module

const io = socketIo(server, {
  cors: { origin: "*" }
});

require('dotenv').config();

// Configure AWS SDK region
AWS.config.update({ region: process.env.AWS_REGION});
const tableName = process.env.TABLE_NAME;
const bucketName = process.env.BUCKET_NAME;
const PORT = process.env.PORT || 4000;

let pythonSocket = null;

io.on("connection", (socket) => {
  console.log("New socket connected:", socket.id);

  // Optionally: tag this as the Python client if it identifies itself
  socket.on("identify", (data) => {
    if (data.role === "python-client") {
      pythonSocket = socket;
      console.log("🐍 Registered Python client:", socket.id);
    }
  });

  socket.on("blurred-image", async (data) => {
  const { originalKey, buffer } = data;
  const blurredKey = originalKey.replace(/\.jpg$/, "_blurred.jpg");


  try {

    const s3 = new AWS.S3();
    await s3
      .putObject({
        Bucket: bucketName,
        Key: blurredKey,
        Body: Buffer.from(buffer, 'base64'),
        ContentType: "image/jpeg",
      })
      .promise();

    console.log("✅ Blurred image uploaded to S3:", blurredKey);
    io.emit("image-blurred", { blurredKey });
    } catch (err) {
      console.error("❌ Failed to upload blurred image:", err);
    }
  });
  
  socket.on("disconnect", () => {
    if (socket === pythonSocket) {
      console.log("🐍 Python client disconnected");
      pythonSocket = null;
    }
  });
  
});

app.use(cors());
app.use(bodyParser.json());

// Simple health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running" });
});

const dynamoDb = new AWS.DynamoDB.DocumentClient();

// Endpoint to get a pre-signed S3 URL for image uploads
app.get("/upload-image", async (req, res) => {
  const s3 = new AWS.S3();
  const fileName = `${uuidv4()}.jpg`;

  const params = {
    Bucket: bucketName,
    Key: fileName,
    Expires: 60, // URL expires in 60 seconds
    ContentType: "image/jpeg", // Expecting JPEG images
  };


  s3.getSignedUrl("putObject", params, (err, url) => {
    if (err) {
      console.error("❌ S3 Signed URL error:", err);
      return res.status(500).json({ error: "Failed to create signed URL" });
    }
    console.log("✅ Generated S3 signed URL:", { fileName, url });

    res.json({ uploadUrl: url, fileName });

    // After getting the signed URL, set a timeout to download the image from S3
    // and send it to the Python client for blurring.
    // Give the frontend client some time to upload the image to S3.
    setTimeout(async () => {
      try {
        const image = await s3
          .getObject({ Bucket: bucketName, Key: fileName })
          .promise();

        console.log("📥 Downloaded image from S3:", fileName);

        // Convert image buffer to base64 string for Socket.IO transmission
        const base64Buffer = image.Body.toString("base64");

        if (pythonSocket) {
          // Emit the image to the Python client for blurring
          pythonSocket.emit("blur-image", {
            originalKey: fileName,
            buffer: base64Buffer,
          });
          console.log("📤 Sent image to Python for blurring");
        } else {
          console.warn("⚠️ No Python client connected. Image not sent for blurring.");
        }
      } catch (err) {
        console.error("❌ Failed to download uploaded image from S3:", err);
      }
    }, 5000); // 5-second delay
  });
});

// Endpoint to store a timestamp in DynamoDB
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


// Start the server
server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT} (or container's port)`);
  console.log(`Expecting AWS_REGION: ${process.env.AWS_REGION}`);
  console.log(`Expecting TABLE_NAME: ${process.env.TABLE_NAME}`);
  console.log(`Expecting BUCKET_NAME: ${process.env.BUCKET_NAME}`);
});
