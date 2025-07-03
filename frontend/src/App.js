import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import axios from "axios";

const socket = io("http://localhost:4000");

function App() {
  const [storedTime, setStoredTime] = useState(null);

const handleClick = async () => {
  try {
    await axios.post("http://localhost:4000/store-time");
  } catch (err) {
    console.error("Error storing time:", err);
    alert("Failed to store time, try again.");
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
      <button onClick={handleClick}>Store Current Time</button>
      {storedTime && (
        <p>Stored Time: {new Date(storedTime).toLocaleString()}</p>
      )}
    </div>
  );
}

export default App;
