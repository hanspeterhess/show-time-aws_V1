import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import axios from "axios";

// Backend address
const BACKEND_URL = "http://63.178.13.188:4000";
const socket = io(BACKEND_URL);

function App() {
  const [storedTime, setStoredTime] = useState(null);
  
  const [imageFile, setImageFile] = useState(null);
  const [uploadedImageUrl, setUploadedImageUrl] = useState("");


const handleClick = async () => {
  try {
    await axios.post("${BACKEND_URL}/store-time");
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
      const { data } = await axios.get(`${BACKEND_URL}/upload-url`);
      const { uploadUrl } = data;

      await axios.put(uploadUrl, imageFile, {
        headers: {
          "Content-Type": imageFile.type,
        },
      });

      const imageUrl = uploadUrl.split("?")[0];
      setUploadedImageUrl(imageUrl);
      alert("Image uploaded successfully!");
    } catch (err) {
      console.error("Upload error:", err);
      alert("Image upload failed");
    }
  };

  useEffect(() => {
    socket.on("time-ready", ({ time }) => {
      setStoredTime(time);
    });
    return () => socket.off("time-ready");
  }, []);

  return (
    <div style={{ textAlign: "center", marginTop: "3rem" }}>
      <h2>Timestamp App</h2>
      <button onClick={handleClick}>Store Current Time</button>
      {storedTime && (
        <p>Stored Time: {new Date(storedTime).toLocaleString()}</p>
      )}
      
      <hr style={{ margin: "2rem 0" }} />

      <h3>Upload Image to S3</h3>
      <input
        type="file"
        accept="image/*"
        onChange={(e) => setImageFile(e.target.files[0])}
      />
      <br /><br />
      <button onClick={handleUpload}>Upload Image</button>

      {uploadedImageUrl && (
        <div style={{ marginTop: "1rem" }}>
          <p>Uploaded Image Preview:</p>
          <img
            src={uploadedImageUrl}
            alt="Uploaded"
            style={{ maxWidth: "300px", border: "1px solid #ccc" }}
          />
        </div>
      )}
    </div>
  );
}

export default App;
