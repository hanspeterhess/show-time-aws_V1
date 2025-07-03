const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "http://localhost:3000" }
});
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");

require('dotenv').config();

// Configure AWS SDK region
AWS.config.update({ region: process.env.AWS_REGION}); // change if your table is in another region
const tableName = process.env.TABLE_NAME;

const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());

const dynamoDb = new AWS.DynamoDB.DocumentClient();

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
