import os
import socketio
from PIL import Image, ImageFilter
import io
import base64
from dotenv import load_dotenv
import time
import logging
import requests

load_dotenv()

# Set up basic logging to stdout, which awslogs will capture
logging.basicConfig(
    level=logging.INFO, # Capture INFO, WARNING, ERROR, CRITICAL messages
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Set this to your Node.js backend's Socket.IO server URL
BACKEND_SERVER_URL = os.getenv("BACKEND_SERVER_URL")
if not BACKEND_SERVER_URL:
    logger.error("❌ ERROR: BACKEND_SERVER_URL environment variable is not set. Exiting.")
    exit(1)

sio = socketio.Client()

@sio.event
def connect():
    logger.info(f"✅ SIO Event: Connected to backend at {BACKEND_SERVER_URL}")
    sio.emit("identify", {"role": "python-client"})

@sio.event
def disconnect():
    logger.warning("❌ SIO Event: Disconnected from backend")

@sio.event
def connect_error(data):
    logger.error(f"❌ SIO Event: Connection failed: {data}")

@sio.on("blur-image")
def on_blur_image(data):

    original_key = data["originalKey"] 
    logger.info(f"🖼️ Received image key for blurring: {original_key}")

    try:
        # 1. Request presigned URL from backend
        get_url_endpoint = f"{BACKEND_SERVER_URL}/get-image-url?key={original_key}"
        logger.info(f"Requesting presigned URL from: {get_url_endpoint}")

        response = requests.get(get_url_endpoint)
        response.raise_for_status() # Raise an exception for HTTP errors (4xx or 5xx)

        presigned_data = response.json()
        image_download_url = presigned_data["url"]
        logger.info("✅ Received presigned URL. Downloading image...")

        # 2. Download image directly from S3 using the presigned URL
        image_response = requests.get(image_download_url)
        image_response.raise_for_status()

        image_bytes = image_response.content # Raw bytes from the image
        logger.info("✅ Image downloaded from S3.")

        # Process image
        image = Image.open(io.BytesIO(image_bytes))
        blurred = image.filter(ImageFilter.GaussianBlur(radius=6))

        # Convert back to bytes for sending back to backend
        out_buf = io.BytesIO()
        blurred.save(out_buf, format="JPEG")
        out_buf.seek(0)

        # Emit back the blurred image (still as base64 to backend for upload)
        blurred_b64 = base64.b64encode(out_buf.read()).decode("utf-8")
        sio.emit("blurred-image", {
            "originalKey": original_key,
            "buffer": blurred_b64
        })
        logger.info("✅ Blurred image sent back to backend")
    except requests.exceptions.RequestException as req_err:
        logger.error(f"❌ HTTP/Network error while getting presigned URL or downloading image: {req_err}", exc_info=True)
    except Exception as e:
        logger.error(f"❌ Error processing image from S3: {e}", exc_info=True)


    # try:
    #     original_key = data["originalKey"]
    #     image_bytes = base64.b64decode(data["buffer"])

    #     # Process image
    #     image = Image.open(io.BytesIO(image_bytes))
    #     blurred = image.filter(ImageFilter.GaussianBlur(radius=6))

    #     # Convert back to bytes
    #     out_buf = io.BytesIO()
    #     blurred.save(out_buf, format="JPEG")
    #     out_buf.seek(0)
        
    #     # Emit back the blurred image
    #     blurred_b64 = base64.b64encode(out_buf.read()).decode("utf-8")
    #     sio.emit("blurred-image", {
    #         "originalKey": original_key,
    #         "buffer": blurred_b64
    #     })
    #     logger.info("✅ Blurred image sent back")
    # except Exception as e:
    #     logger.error(f"❌ Error processing image: {e}", exc_info=True) # exc_info=True prints traceback



def main():
    while True:
        try:
            logger.info(f"🔌 Attempting connection to {BACKEND_SERVER_URL}...")
            sio.connect(BACKEND_SERVER_URL)
            # This logger.info call should definitely show up
            logger.info("--- AS Main Loop: sio.connect() call returned successfully. Entering wait state. ---")
            sio.wait() # This blocks the main thread until disconnect or error
            logger.info("--- AS Main Loop: sio.wait() finished. ---")
        except Exception as e:
            logger.error(f"⚠️ Connection error in main loop: {e}", exc_info=True)
            logger.info("🔁 Retrying connection in 5 seconds...")
            time.sleep(5)


if __name__ == "__main__":
    main()
