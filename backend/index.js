const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = express();
const server = http.createServer(app);
const AWS = require("aws-sdk"); 
const { v4: uuidv4 } = require("uuid");

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

// S3 Helper Functions
const s3BackendService = {
  // Generates a presigned URL for S3 operations
  generatePresignedUrl: async (key, action, expiresSeconds = 300) => {
    const s3 = new AWS.S3();
    const params = {
      Bucket: bucketName,
      Key: key,
      Expires: expiresSeconds,
    };
    try {
      const url = await s3.getSignedUrlPromise(action, params);
      console.log(`✅ Generated S3 presigned ${action.toUpperCase()} URL for key: ${key}`);
      return url;
    } catch (err) {
      console.error(`❌ S3 Signed URL error for ${action}:`, err);
      throw err;
    }
  },

  // Checks if an object exists in S3 using headObject
  checkS3ObjectExists: async (key) => {
    const s3 = new AWS.S3();
    const params = {
      Bucket: bucketName,
      Key: key,
    };
    try {
      await s3.headObject(params).promise();
      console.log(`✅ Object ${key} exists in S3.`);
      return true;
    } catch (headErr) {
      if (headErr.code === 'NotFound') {
        console.warn(`⚠️ Object ${key} not found in S3.`);
        return false;
      }
      console.error(`❌ Error checking S3 object existence for ${key}:`, headErr);
      throw headErr;
    }
  }
};


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

    setTimeout(async () => {
      try {
        const exists = await s3BackendService.checkS3ObjectExists(originalKey);
        if (!exists) {
          console.error(`File ${originalKey} not found in S3 after delay. Cannot proceed with blurring.`);
          io.emit("upload-error", { message: `File ${originalKey} not found in S3.` });
          return;
        }

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

  const { key } = req.query;
  if (!key) {
      return res.status(400).json({ error: "Image key is required." });
  }

  try {
    const exists = await s3BackendService.checkS3ObjectExists(key);
    if (!exists) {
      return res.status(404).json({ error: `Object with key '${key}' not found.` });
    }
    const url = await s3BackendService.generatePresignedUrl(key, "getObject", 300); // 5 minutes expiry
    res.json({ url });
  } catch (err) {
    console.error(`❌ Error in /get-image-url for key ${key}:`, err);
    res.status(500).json({ error: "Failed to create signed GET URL." });
  }
});


// Simple health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is running" });
});


// Endpoint to get a pre-signed S3 URL for image uploads (from frontend)
app.get("/get-upload-url", async (req, res) => {
  const originalFileName = req.query.fileName;
  let fileName; 
  
  // Ensure we consistently use .nii.gz for S3 keys
  if (originalFileName && originalFileName.toLowerCase().endsWith('.nii.gz')) {
      fileName = `${uuidv4()}.nii.gz`; 
  } else {
      fileName = `${uuidv4()}.nii.gz`;
      console.warn(`Frontend requested upload for non-.nii.gz file: ${originalFileName}. Forcing .nii.gz key.`);
  }

  try {
    const uploadUrl = await s3BackendService.generatePresignedUrl(fileName, "putObject", 60); // 60 seconds expiry
    res.json({ uploadUrl: uploadUrl, fileName: fileName });
  } catch (err) {
    res.status(500).json({ error: "Failed to create signed PUT URL." });
  }
});

// get a pre-signed S3 URL for blurred image uploads (from AS)
app.get("/get-blurred-upload-url", async (req, res) => {
    const { originalKey } = req.query;

    if (!originalKey) {
        return res.status(400).json({ error: "originalKey is required." });
    }

    // Determine the blurred key based on the originalKey's extension, ensuring it's .nii.gz
    let blurredKey = originalKey.replace(/\.nii\.gz$/, '_blurred.nii.gz');

    try {
        const uploadUrl = await s3BackendService.generatePresignedUrl(blurredKey, "putObject", 120); // 120 seconds expiry
        res.json({ uploadUrl: uploadUrl, blurredKey: blurredKey });
    } catch (err) {
        res.status(500).json({ error: "Failed to create signed URL for blurred image." });
    }
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
