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
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8, // 100 MB buffer size
});

require('dotenv').config();

// Configure AWS SDK region
AWS.config.update({ region: process.env.AWS_REGION});
const tableName = process.env.TABLE_NAME;
const bucketName = process.env.BUCKET_NAME;
const PORT = process.env.PORT || 4000;

let pythonSocket = null;

const dynamoDb = new AWS.DynamoDB.DocumentClient();

io.on("connection", (socket) => {
  console.log("New socket connected:", socket.id);

  // tag this as the Python client if it identifies itself
  socket.on("identify", (data) => {
    if (data.role === "python-client") {
      pythonSocket = socket;
      console.log("🐍 Registered Python client:", socket.id);
    }
  });

  socket.on("blurred-image-uploaded", ({ originalKey, blurredKey }) => { // Renamed event and data structure
    console.log("✅ Blurred image uploaded by AS to S3:", blurredKey);
    io.emit("image-blurred", { blurredKey, originalKey }); // Notify frontend
  });

  socket.on("image-uploaded-to-s3", async ({ originalKey }) => {
    console.log(`Frontend reported upload complete for: ${originalKey}`);
    const s3 = new AWS.S3();

    setTimeout(async () => {
      try {
        const headParams = {
          Bucket: bucketName,
          Key: originalKey,
        };
        await s3.headObject(headParams).promise();

        console.log(`✅ Object ${originalKey} verified in S3. Triggering blurring.`);

        if (pythonSocket) {
          pythonSocket.emit("blur-image", {
            originalKey: originalKey
          });
          console.log(`📤 Sent blur request for ${originalKey} to Python AS`);
        } else {
          console.warn("⚠️ No Python client connected. Image not sent for blurring.");
        }
      } catch (err) {
        console.error(`❌ Failed to verify or request blurring for ${originalKey}:`, err);
        if (err.code === 'NotFound' || err.statusCode === 404) {
          console.error(`File ${originalKey} not found in S3 after delay. Cannot proceed with blurring.`);
        }
      }
    }, 5000);
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


// Endpoint to get a pre-signed S3 URL for downloading/displaying an image
app.get("/get-image-url", async (req, res) => {

  const { key } = req.query; // Image key (e.g., "uuid.jpg" or "uuid_blurred.jpg")
  if (!key) {
      return res.status(400).json({ error: "Image key is required." });
  }

  const s3 = new AWS.S3();
 const headParams  = {
      Bucket: bucketName,
      Key: key,
  };
  
  try {
    // Check if the object exists first
    await s3.headObject(headParams).promise();
    // If headObject succeeds, the object exists. Proceed to generate presigned URL.
    console.log(`✅ Object ${key} exists in S3. Generating presigned URL.`);
  } catch (headErr) {
    if (headErr.code === 'NotFound') {
      console.warn(`⚠️ Object ${key} not found in S3.`);
      return res.status(404).json({ error: `Object with key '${key}' not found.` });
    }
    console.error(`❌ Error checking S3 object existence for ${key}:`, headErr);
    return res.status(500).json({ error: "Failed to verify object existence." });
  }

  // Parameters for getSignedUrl - Expires IS valid here
  const getObjectSignedUrlParams = {
      Bucket: bucketName,
      Key: key,
      Expires: 300 // URL valid for 300 seconds (5 minutes)
  };

  s3.getSignedUrl("getObject", getObjectSignedUrlParams, (err, url) => {
      if (err) {
          console.error("❌ S3 Signed URL error for getObject:", err);
          return res.status(500).json({ error: "Failed to create signed URL." });
      }
      res.json({ url });
      console.log(`✅ Generated S3 signed GET URL for key ${key}`);
  }); 
});


// Simple health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running" });
});


// Endpoint to get a pre-signed S3 URL for image uploads (from frontend)
app.get("/get-upload-url", async (req, res) => {
  const s3 = new AWS.S3();
  const originalFileName = req.query.fileName; // This is primarily for logging/user reference
  let fileName; // The actual S3 key
  
  // Ensure we consistently use .nii.gz for S3 keys
  if (originalFileName && originalFileName.toLowerCase().endsWith('.nii.gz')) {
      fileName = `${uuidv4()}.nii.gz`; // Generate new UUID-based name
  } else {
      // If the originalFileName is missing or doesn't end with .nii.gz, still enforce the correct extension.
      // This is a safety for cases where frontend might not send correct extension.
      fileName = `${uuidv4()}.nii.gz`;
      console.warn(`Frontend requested upload for non-.nii.gz file: ${originalFileName}. Forcing .nii.gz key.`);
  }

  const params = {
    Bucket: bucketName,
    Key: fileName,
    Expires: 60, // URL expires in 60 seconds
    ContentType: "application/octet-stream", 
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

// get a pre-signed S3 URL for blurred image uploads (from AS)
app.get("/get-blurred-upload-url", async (req, res) => {
    const s3 = new AWS.S3();
    const { originalKey } = req.query; // AS sends originalKey so backend can derive blurredKey

    if (!originalKey) {
        return res.status(400).json({ error: "originalKey is required." });
    }

    // Determine the blurred key based on the originalKey's extension, ensuring it's .nii.gz
    let blurredKey = originalKey.replace(/\.nii\.gz$/, '_blurred.nii.gz');

    const params = {
        Bucket: bucketName,
        Key: blurredKey,
        Expires: 120, // URL valid for 120 seconds (2 minutes) for AS upload
        ContentType: "application/octet-stream",
    };

    s3.getSignedUrl("putObject", params, (err, url) => {
        if (err) {
            console.error("❌ S3 Signed URL error for blurred upload:", err);
            return res.status(500).json({ error: "Failed to create signed URL for blurred image." });
        }
        console.log("✅ Generated S3 signed PUT URL for AS blurred upload:", { blurredKey, url });
        res.json({ uploadUrl: url, blurredKey });
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
