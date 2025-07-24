import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import axios from "axios";
import { v4 as uuidv4 } from 'uuid';

// Backend address - Read from environment variable injected by Amplify
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:4000";

// Initialize socket connection
const socket = io(BACKEND_URL);

function App() {
  const [storedTime, setStoredTime] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const [originalFileName, setOriginalFileName] = useState("");
  const [blurredFileName, setBlurredFileName] = useState("");
  const [blurredDownloadUrl, setBlurredDownloadUrl] = useState(""); // NEW: State for blurred download URL


  const handleDownloadBlurred = async () => {
    if (!blurredDownloadUrl || !blurredFileName) {
      alert("Blurred image not ready for download.");
      return;
    }
    try {
      // Create a temporary anchor element to trigger download
      const link = document.createElement('a');
      link.href = blurredDownloadUrl;
      // Use blurredFileName for the suggested download name
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
      // 1. Generate a unique filename on the frontend (as you had before)
      const fileName = `${uuidv4()}.nii.gz`;
      console.log(`Frontend: Requesting upload URL for fileName: ${fileName}`);

      // 2. Get the presigned PUT URL from the backend's /upload-url endpoint
      // This endpoint will return the actual S3 key (fileName) it generated.
      const uploadUrlResponse = await axios.get(`${BACKEND_URL}/get-upload-url?fileName=${fileName}`);
      const { uploadUrl, fileName: receivedFileName } = uploadUrlResponse.data; // Use receivedFileName from backend
      
      // For displaying the original image URL in the UI
      setOriginalFileName(uploadUrl.split("?")[0]);

      // Log the fileName received from backend for debugging
      console.log("Frontend: Received fileName from backend for upload:", receivedFileName);

      // 3. Upload image directly to S3 using the presigned URL
      await axios.put(uploadUrl, imageFile, {
        headers: {
          "Content-Type": imageFile.type,
        },
      });

      // 4. After successful S3 upload, inform backend via socket with the CORRECT receivedFileName
      socket.emit("image-uploaded-to-s3", { originalKey: receivedFileName });

      console.log(`App.js: Image successfully PUT to S3. Emitting 'image-uploaded-to-s3' for originalKey: ${receivedFileName}`);
      alert("File uploaded successfully! Processing will begin shortly.");
    } catch (err) {
      console.error("Error uploading file:", err);
      // Check for specific backend errors (like unsupported file type)
      if (err.response && err.response.data && err.response.data.error) {
          alert(`Failed to upload file: ${err.response.data.error}`);
      } else {
          alert("Failed to upload file. See console for details.");
      }
    }
  };



  //Socket.IO connection logging
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
      console.log('🖼️ Received blurred image notification:', blurredKey);
      
      // Construct the public S3 URL for the blurred image
      setBlurredFileName(blurredKey);

      // NEW: Request presigned download URL for the blurred image
      try {
        const response = await axios.get(`${BACKEND_URL}/get-image-url?key=${blurredKey}`);
        const { url } = response.data;
        setBlurredDownloadUrl(url); // Store the presigned URL
        console.log("✅ Frontend: Received blurred image download URL.");
      } catch (error) {
        console.error("❌ Frontend: Error getting blurred image download URL:", error);
        setBlurredDownloadUrl(""); // Clear if there's an error
      }
      alert("Blurred image is ready for download!");
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off("time-ready");
      socket.off("image-blurred");
      socket.off("image-uploaded-to-s3");
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
              Download Blurred .nii.gz
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;