const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = express();
const server = http.createServer(app);
const AWS = require("aws-sdk"); 
const { v4: uuidv4 } = require("uuid");
const { auth } = require('express-oauth2-jwt-bearer'); // Auth0 JWT validation middleware

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

const ORCHESTRATOR_LAMBDA_NAME = process.env.ORCHESTRATOR_LAMBDA_NAME;
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const BACKEND_ALB_DNS = process.env.BACKEND_ALB_DNS; // For callback URL construction

const dynamoDb = new AWS.DynamoDB.DocumentClient();
// const lambda = new AWS.Lambda();
const sqs = new AWS.SQS(); 

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

});


app.use(cors());
app.use(bodyParser.json());

// Debug
// app.use((req, res, next) => {
//   const authHeader = req.headers.authorization;
//   if (authHeader) {
//     console.log('Incoming Authorization Header:', authHeader);
//     // Extract the token to log just the token itself
//     const token = authHeader.split(' ')[1];
//     if (token) {
//       console.log('Incoming JWT:', token);
//     }
//   }
//   next(); // Pass control to the next middleware
// });

// Auth0 JWT Validation Middleware
// This middleware will check for a valid JWT in the Authorization header
// and ensure it was issued by your Auth0 domain and for your API audience.
const checkJwt = auth({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
});

// Endpoint for AS ECS task to call back to after blurring is complete
app.post("/blurred-image-callback", (req, res) => {
    const { originalKey, blurredKey, error } = req.body; // Added error field
    if (error) {
        console.error(`❌ Backend: Lambda callback reported error for ${originalKey}: ${error}`);
        io.emit("processing-error", { originalKey, message: `Processing failed: ${error}` });
        return res.status(200).json({ status: "error", message: "Callback received with error" });
    }
    if (!originalKey || !blurredKey) {
        console.error("❌ Backend: Missing originalKey or blurredKey in callback.");
        return res.status(400).json({ error: "Missing originalKey or blurredKey in callback." });
    }
    console.log(`✨ Backend: AS callback received for original: ${originalKey}, blurred: ${blurredKey}`);
    io.emit("image-blurred", { blurredKey, originalKey }); // Notify frontend
    res.json({ status: "success", message: "Callback received" });
});

// Endpoint to get a pre-signed S3 URL for downloading/displaying an image
// This is protected and requires a valid JWT
app.get("/get-image-url", checkJwt, async (req, res) => {
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
// This is protected and requires a valid JWT
app.get("/get-upload-url", checkJwt, async (req, res) => {
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
    let blurredKey = originalKey.replace(/\.nii\.gz$/, '_segmented.nii.gz');

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

// Endpoint for Frontend to invoke blurring (now invokes Lambda)
// This is protected and requires a valid JWT
app.post("/invoke-blur-process", checkJwt, async (req, res) => {
    const { originalKey } = req.body;
    if (!originalKey) {
        return res.status(400).json({ error: "originalKey is required to invoke blurring." });
    }

    if (!ORCHESTRATOR_LAMBDA_NAME || !SQS_QUEUE_URL) {
        console.error("Orchestrator Lambda or SQS Queue not configured. Cannot initiate blurring.");
        return res.status(500).json({ error: "Blurring service not configured." });
    }

    try {
        await sqs.sendMessage({
            QueueUrl: SQS_QUEUE_URL,
            MessageBody: JSON.stringify({ originalKey: originalKey }),
        }).promise();
        console.log(`✅ Message sent to SQS queue ${SQS_QUEUE_URL} for originalKey: ${originalKey}`);

        // 2. Invoke the orchestrator Lambda (to scale up ECS if needed)

        //  currently disabled because scale-down alarm anyway scales down AS service
        // const payload = { originalKey: originalKey }; // Lambda needs originalKey to decide if it should scale up
        // const invokeResult = await lambda.invoke({
        //     FunctionName: ORCHESTRATOR_LAMBDA_NAME,
        //     InvocationType: 'Event', // Asynchronous invocation
        //     Payload: JSON.stringify(payload),
        // }).promise();

        // console.log(`✅ Successfully invoked orchestrator Lambda ${ORCHESTRATOR_LAMBDA_NAME} for ${originalKey}`);
        res.json({ status: "success", message: "Blurring process initiated. Check status via frontend updates." });
    } catch (err) {
        console.error(`❌ Error initiating blurring process:`, err);
        res.status(500).json({ error: "Failed to initiate blurring process." });
    }
});

// Start the server
server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT} (or container's port)`);
  console.log(`Expecting AWS_REGION: ${process.env.AWS_REGION}`);
  console.log(`Expecting TABLE_NAME: ${process.env.TABLE_NAME}`);
  console.log(`Expecting BUCKET_NAME: ${process.env.BUCKET_NAME}`);
  console.log(`Expecting ORCHESTRATOR_LAMBDA_NAME: ${process.env.ORCHESTRATOR_LAMBDA_NAME || 'NOT SET'}`);
  console.log(`Expecting SQS_QUEUE_URL: ${process.env.SQS_QUEUE_URL || 'NOT SET'}`);
  console.log(`Expecting BACKEND_ALB_DNS: ${process.env.BACKEND_ALB_DNS || 'NOT SET'}`);
  console.log(`Expecting AUTH0_AUDIENCE: ${process.env.AUTH0_AUDIENCE || 'NOT SET'}`);
  console.log(`Expecting AUTH0_ISSUER_BASE_URL: ${process.env.AUTH0_ISSUER_BASE_URL || 'NOT SET'}`);

});
