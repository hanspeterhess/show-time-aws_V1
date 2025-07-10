import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import axios from "axios";

// Backend address - Read from environment variable injected by Amplify
// During local development, you can set REACT_APP_BACKEND_URL in a .env.local file
// or directly use "http://localhost:4000" if running locally.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:4000";

// Initialize socket connection
const socket = io(BACKEND_URL);

function App() {
  const [storedTime, setStoredTime] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [uploadedImageUrl, setUploadedImageUrl] = useState("");
  const [blurredImageUrl, setBlurredImageUrl] = useState("");

  // IMPORTANT: Replace these placeholders with your actual S3 bucket name and AWS region
  // You can get these from your Pulumi outputs.
  const S3_BUCKET_NAME = "uploadbucket-5775bc9"; // update this
  const AWS_REGION = "eu-central-1"; 

  const handleClick = async () => {
    try {
      await axios.post(`${BACKEND_URL}/store-time`);
      alert("Time stored successfully!");
    } catch (err) {
      console.error("Error storing time:", err);
      alert("Failed to store time, try again.");
    }
  };

  const handleUpload = async () => {
    if (!imageFile) {
      alert("Please select an image first");
      return;
    }

    try {
      // 1. Get a pre-signed S3 URL from the backend
      const { data } = await axios.get(`${BACKEND_URL}/upload-url`);
      const { uploadUrl } = data; // fileName is the S3 key

      // 2. Upload the image directly to S3 using the pre-signed URL
      await axios.put(uploadUrl, imageFile, {
        headers: {
          "Content-Type": imageFile.type,
        },
      });

      // 3. Construct the public S3 URL for preview
      const s3BaseUrl = uploadUrl.split("?")[0];
      setUploadedImageUrl(s3BaseUrl);

      alert("Image uploaded to S3 successfully! Processing will begin shortly.");

    } catch (err) {
      console.error("Upload error:", err);
      alert("Image upload failed. Check console for details.");
    }
  };

  useEffect(() => {
    socket.on("time-ready", ({ time }) => {
      setStoredTime(time);
    });

    socket.on("image-blurred", ({ blurredKey }) => {
      console.log('🖼️ Received blurred image notification:', blurredKey);
      // Construct the public S3 URL for the blurred image
      const blurredS3Url = `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${blurredKey}`;
      
      setBlurredImageUrl(blurredS3Url);
      alert("Blurred image received and ready for display!");
    });

    return () => {
      socket.off("time-ready");
      socket.off("image-blurred");
    };
  }, []);

  return (
    <div style={{ textAlign: "center", marginTop: "3rem", fontFamily: "Inter, sans-serif" }}>
      <h1 style={{ color: '#2c3e50' }}>Image Processing App</h1>

      <div style={{ background: '#ecf0f1', padding: '20px', borderRadius: '10px', margin: '20px auto', maxWidth: '500px', boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>
        <h2 style={{ color: '#34495e' }}>Timestamp Feature</h2>
        <button
          onClick={handleClick}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            backgroundColor: '#3498db',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            transition: 'background-color 0.3s ease',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#2980b9'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#3498db'}
        >
          Store Current Time
        </button>
        {storedTime && (
          <p style={{ marginTop: '15px', fontSize: '1.1em', color: '#34495e' }}>
            Stored Time: <span style={{ fontWeight: 'bold', color: '#2c3e50' }}>{new Date(storedTime).toLocaleString()}</span>
          </p>
        )}
      </div>
      
      <hr style={{ margin: "2rem auto", width: '80%', borderColor: '#bdc3c7' }} />

      <div style={{ background: '#ecf0f1', padding: '20px', borderRadius: '10px', margin: '20px auto', maxWidth: '500px', boxShadow: '0 4px 8px rgba(0,0,0,0.1)' }}>
        <h2 style={{ color: '#34495e' }}>Image Blurring Service</h2>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setImageFile(e.target.files[0])}
          style={{ display: 'block', margin: '15px auto', padding: '10px', border: '1px solid #ccc', borderRadius: '5px' }}
        />
        <button
          onClick={handleUpload}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            backgroundColor: '#2ecc71',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            transition: 'background-color 0.3s ease',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#27ae60'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#2ecc71'}
        >
          Upload Image to AWS S3
        </button>

        {uploadedImageUrl && (
          <div style={{ marginTop: "20px", borderTop: '1px solid #bdc3c7', paddingTop: '20px' }}>
            <p style={{ fontSize: '1.1em', color: '#34495e' }}>Original Image (from S3):</p>
            <img
              src={uploadedImageUrl}
              alt="Uploaded Original"
              style={{ maxWidth: "100%", maxHeight: "300px", borderRadius: '8px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)' }}
            />
          </div>
        )}

        {blurredImageUrl && (
          <div style={{ marginTop: "20px", borderTop: '1px solid #bdc3c7', paddingTop: '20px' }}>
            <p style={{ fontSize: '1.1em', color: '#34495e' }}>Blurred Image (from S3):</p>
            <img
              src={blurredImageUrl}
              alt="Blurred"
              style={{ maxWidth: "100%", maxHeight: "300px", borderRadius: '8px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)' }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
