import os
import socketio
from PIL import Image, ImageFilter
import io
import base64
from dotenv import load_dotenv
import time

load_dotenv()

# Set this to your Node.js backend's Socket.IO server URL
# This will be provided by Pulumi as an environment variable (e.g., Load Balancer DNS)
BACKEND_SERVER_URL = os.getenv("BACKEND_SERVER_URL")
# Ensure BACKEND_SERVER_URL is set
if not BACKEND_SERVER_URL:
    print("❌ ERROR: BACKEND_SERVER_URL environment variable is not set.")
    print("Please set it to the URL of your Node.js backend (e.g., http://your-load-balancer-dns:4000)")
    exit(1) # Exit if critical environment variable is missing

sio = socketio.Client()

@sio.event
def connect():
    print("✅ Connected to backend")
    sio.emit("identify", {"role": "python-client"})


@sio.event
def disconnect():
    print("❌ Disconnected from backend")


@sio.on("blur-image")
def on_blur_image(data):
    print("🖼️ Received image to blur...")

    try:
        original_key = data["originalKey"]
        image_bytes = base64.b64decode(data["buffer"])

        # Process image
        image = Image.open(io.BytesIO(image_bytes))
        blurred = image.filter(ImageFilter.GaussianBlur(radius=6))

        # Convert back to bytes
        out_buf = io.BytesIO()
        blurred.save(out_buf, format="JPEG")
        out_buf.seek(0)
        
        # Emit back the blurred image
        blurred_b64 = base64.b64encode(out_buf.read()).decode("utf-8")
        sio.emit("blurred-image", {
            "originalKey": original_key,
            "buffer": blurred_b64
        })
        print("✅ Blurred image sent back")
    except Exception as e:
        print(f"❌ Error processing image: {e}")


def main():
    while True:
        try:
            print(f"🔌 Connecting to {BACKEND_SERVER_URL}...")
            sio.connect(BACKEND_SERVER_URL)
            sio.wait()
        except Exception as e:
            print(f"⚠️ Connection error: {e}")
            print("🔁 Retrying in 5 seconds...")
            time.sleep(5)


if __name__ == "__main__":
    main()
