#!/bin/bash
sudo apt update -y
sudo apt install -y curl unzip
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Create backend directory
mkdir -p /home/ubuntu/backend
cd /home/ubuntu/backend

# Sample Express server (this will be overwritten via Git pull or SCP later)
cat <<EOF > server.js
const express = require('express');
const AWS = require('aws-sdk');
const fs = require('fs');
const app = express();
const s3 = new AWS.S3();
const bucket = process.env.S3_BUCKET;

app.get('/save-time', async (req, res) => {
    const now = new Date().toISOString();
    const key = 'time.json';
    const params = {
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify({ time: now }),
        ContentType: 'application/json'
    };
    try {
        await s3.putObject(params).promise();
        res.send({ message: 'Time saved', time: now });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error writing to S3');
    }
});

app.listen(3000, () => {
    console.log('Backend running on port 3000');
});
EOF

# Install dependencies and start server
npm init -y
npm install express aws-sdk
node server.js > server.log 2>&1 &
