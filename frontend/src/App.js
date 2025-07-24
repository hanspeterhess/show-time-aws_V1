import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import axios from "axios";
import { v4 as uuidv4 } from 'uuid';

// Backend address - Read from environment variable injected by Amplify
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:4000";

// Initialize socket connection
const socket = io(BACKEND_URL);

// S3 Service for Frontend Interactions
const s3FrontendService = {
  // Fetches a presigned GET URL from the backend
  fetchDownloadUrl: async (key) => {
    try {
      const response = await axios.get(`${BACKEND_URL}/get-image-url?key=${key}`);
      return response.data.url;
    } catch (error) {
      console.error(`Error fetching download URL for ${key}:`, error);
      throw error; // Re-throw to be handled by caller
    }
  },

  // Uploads a file to S3 using a presigned PUT URL obtained from the backend
  uploadFileToS3: async (file, backendUploadUrlEndpoint) => {
    // 1. Get presigned PUT URL from backend
    const fileName = `${uuidv4()}.nii.gz`; // Enforce .nii.gz extension
    console.log(`Frontend: Requesting upload URL for fileName: ${fileName}`);

    const uploadUrlResponse = await axios.get(`${backendUploadUrlEndpoint}?fileName=${fileName}`);
    const { uploadUrl, fileName: receivedFileName } = uploadUrlResponse.data;
    
    console.log("Frontend: Received fileName from backend for upload:", receivedFileName);

    // 2. Upload file directly to S3 using the presigned URL
    await axios.put(uploadUrl, file, {
      headers: {
        "Content-Type": "application/octet-stream", // Content-Type for .nii.gz
      },
    });

    console.log(`Frontend: File successfully PUT to S3: ${receivedFileName}`);
    return { uploadedFileName: receivedFileName }; // Return the actual filename used for S3
  }
};

function App() {
  const [storedTime, setStoredTime] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [originalFileName, setOriginalFileName] = useState("");
  const [blurredFileName, setBlurredFileName] = useState("");
  const [blurredDownloadUrl, setBlurredDownloadUrl] = useState("");

  // Function to initiate download
  const handleDownloadBlurred = async () => {
    if (!blurredDownloadUrl || !blurredFileName) {
      alert("Blurred image not ready for download.");
      return;
    }
    try {
      // Create a temporary anchor element to trigger download
      const link = document.createElement('a');
      link.href = blurredDownloadUrl;
      link.download = `blurred_${blurredFileName}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      console.log(`✅ Download initiated for ${blurredFileName}`);
    } catch (error) {
      console.error("❌ Error initiating download:", error);
      alert("Failed to initiate download.");
    }
  };

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

    // Client-side validation for .nii.gz
    if (!imageFile.name.toLowerCase().endsWith('.nii.gz')) {
      alert("Only .nii.gz files are supported for upload and blurring.");
      setImageFile(null); // Clear selected file
      return;
    }

    try {

      const { uploadedFileName } = await s3FrontendService.uploadFileToS3(imageFile, `${BACKEND_URL}/get-upload-url`);
      
      setOriginalFileName(uploadedFileName);

      socket.emit("image-uploaded-to-s3", { originalKey: receivedFileName });

      alert("File uploaded successfully! Processing will begin shortly.");
    } catch (err) {
      console.error("Error uploading file:", err);
      if (err.response && err.response.data && err.response.data.error) {
          alert(`Failed to upload file: ${err.response.data.error}`);
      } else {
          alert("Failed to upload file. See console for details.");
      }
    }
  };

  useEffect(() => {
    socket.on('connect', () => {
      console.log('✅ Frontend Socket.IO connected!');
      console.log('Socket ID:', socket.id);
    });

    socket.on('disconnect', () => {
      console.log('❌ Frontend Socket.IO disconnected!');
    });

    socket.on('connect_error', (err) => {
      console.error('⚠️ Frontend Socket.IO connection error:', err);
    });

    socket.on("time-ready", ({ time }) => {
      setStoredTime(time);
    });

    socket.on("image-blurred", async ({ blurredKey, originalKey }) => {
      console.log('✨ Frontend: Image blurred event received!', blurredKey);
      
      // Construct the public S3 URL for the blurred image
      setBlurredFileName(blurredKey);

      // Request presigned download URL for the blurred image
      try {
        const url = await s3FrontendService.fetchDownloadUrl(blurredKey);
        setBlurredDownloadUrl(url);
        console.log("✅ Frontend: Received blurred image download URL.");
      } catch (error) {
        console.error("❌ Frontend: Error getting blurred image download URL:", error);
        setBlurredDownloadUrl(""); // Clear if there's an error
      }
      alert("Blurred image is ready for download!");
    });

    socket.on("upload-error", (data) => {
        alert(`Upload Error: ${data.message}`);
        console.error("Backend upload error:", data.message);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off("time-ready");
      socket.off("image-blurred");
      socket.off("image-uploaded-to-s3");
      socket.off("upload-error");
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
          accept=" .nii.gz"
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

        {/* Only show download button if a blurred file is ready */}
        {blurredFileName && blurredDownloadUrl && (
          <div style={{ marginTop: "20px", borderTop: '1px solid #bdc3c7', paddingTop: '20px' }}>
            <p style={{ fontSize: '1.1em', color: '#34495e' }}>
              Blurred File: <span style={{ fontWeight: 'bold', color: '#2c3e50' }}>{blurredFileName}</span> is ready!
            </p>
            <button
              onClick={handleDownloadBlurred}
              style={{
                marginTop: '15px',
                padding: '10px 20px',
                backgroundColor: '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
                transition: 'background-color 0.3s ease',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
              }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#0056b3'}
              onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#007bff'}
            >
              Download Blurred NIFTI 
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;