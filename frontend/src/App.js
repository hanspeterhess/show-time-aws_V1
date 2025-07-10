import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import axios from "axios";

// Backend address
// const BACKEND_URL = "http://3.70.250.119:4000";
const BACKEND_URL = "http://localhost:4000";
const socket = io(BACKEND_URL);

function App() {
  const [storedTime, setStoredTime] = useState(null);
  
  const [imageFile, setImageFile] = useState(null);
  const [uploadedImageUrl, setUploadedImageUrl] = useState("");
  const [blurredImageUrl, setBlurredImageUrl] = useState(""); 


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
      // Direct POST to the new /upload-image endpoint
      const response = await axios.post(`${BACKEND_URL}/upload-image`, imageFile, {
        headers: {
          "Content-Type": imageFile.type, // Important: Send the correct content type
        },
      });


      // The backend now returns { status: "ok", fileName }
      const { fileName } = response.data;

      // For local testing, you can construct a URL for the original image
      // if you add a static server for the 'uploads' folder in your backend
      // (similar to how we serve 'blurred' images).
      // For now, let's just confirm upload.
      console.log("Original image uploaded (locally saved) with filename:", fileName);
      alert("Image sent to backend for processing!");
      // You can set the original image URL if your backend serves the 'uploads' folder
      setUploadedImageUrl(`${BACKEND_URL}/uploads/${fileName}`); 

      // const { data } = await axios.get(`${BACKEND_URL}/upload-url`);
      // const { uploadUrl } = data;

      // await axios.put(uploadUrl, imageFile, {
      //   headers: {
      //     "Content-Type": imageFile.type,
      //   },
      // });

      // const imageUrl = uploadUrl.split("?")[0];
      // setUploadedImageUrl(imageUrl);
      alert("Image uploaded successfully!");

    } catch (err) {
      console.error("Upload error:", err);
      alert("Image upload failed");
    }
  };

  useEffect(() => {
    // This socket event handler for 'time-ready' is related to the /store-time endpoint.
    // If you commented out /store-time in backend, this won't trigger.
    socket.on("time-ready", ({ time }) => {
      setStoredTime(time);
    });

    // socket event listener for blurred images
    socket.on("image-blurred", ({ blurredKey }) => {
      console.log('🖼️ Received blurred image notification:', blurredKey);
      // Construct the URL to display the blurred image, assuming your backend serves it
      setBlurredImageUrl(`${BACKEND_URL}/blurred/${blurredKey}`);
      alert("Blurred image received!");
    });

    return () => {
      socket.off("time-ready");
      socket.off("image-blurred");
    };
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
          <p>Original Image Preview:</p>
          <img
            src={uploadedImageUrl}
            alt="Uploaded"
            style={{ maxWidth: "300px", border: "1px solid #ccc" }}
          />
        </div>
      )}

      {blurredImageUrl && (
        <div style={{ marginTop: "1rem" }}>
          <p>Blurred Image Preview:</p>
          <img
            src={blurredImageUrl}
            alt="Blurred"
            style={{ maxWidth: "300px", border: "1px solid #ccc" }}
          />
        </div>
      )}
    </div>
  );
}

export default App;
