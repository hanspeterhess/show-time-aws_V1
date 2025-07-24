import os
import socketio
from PIL import Image, ImageFilter
import io
import base64
from dotenv import load_dotenv
import time
import logging
import requests

import nibabel as nib
from scipy.ndimage import gaussian_filter

import tempfile 

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
    logger.info("🖼️ Received image for blurring")
    original_key = data["originalKey"]

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

        blurred_b64 = None

        logger.info(f"Processing NIfTI file: {original_key}")

        # Use a temporary file to load NIfTI data
        # `tempfile.NamedTemporaryFile` creates a file that is automatically deleted when closed
        # `suffix` ensures the temporary file has the correct extension for nibabel
        with tempfile.NamedTemporaryFile(delete=True, suffix='.nii.gz') as temp_nii_file:
            temp_nii_file.write(image_bytes) # Write the downloaded bytes to the temporary file
            temp_nii_file.flush() # Ensure all data is written to disk before reading
            temp_nii_file_path = temp_nii_file.name
            logger.info(f"Wrote NIfTI bytes to temporary file: {temp_nii_file_path}")

            try:
                # Load NIfTI data from the temporary file path
                img = nib.load(temp_nii_file_path) # <--- Now loading from a file path
                nifti_data = img.get_fdata()

                # Apply 3D Gaussian blur
                blurred_nifti_data = gaussian_filter(nifti_data, sigma=3.0)

                # Create a new NIfTI image from the blurred data
                blurred_img = nib.Nifti1Image(blurred_nifti_data, img.affine, img.header)

                with tempfile.NamedTemporaryFile(delete=True, suffix='.nii.gz') as temp_blurred_nii_file:
                        temp_blurred_nii_file_path = temp_blurred_nii_file.name
                        logger.info(f"Saving blurred NIfTI to temporary file: {temp_blurred_nii_file_path}")
                        nib.save(blurred_img, temp_blurred_nii_file_path)
                        temp_blurred_nii_file.flush()
                        temp_blurred_nii_file.seek(0)
                        blurred_nifti_bytes = temp_blurred_nii_file.read()
                        logger.info("✅ Blurred 3D NIfTI data prepared from temporary file")

            except Exception as load_err:
                logger.error(f"❌ Error loading NIfTI from temporary file {temp_nii_file_path}: {load_err}", exc_info=True)
                # If loading fails, we should not proceed with emitting blurred data
                return
            
        # Request presigned PUT URL from backend for the blurred image
        get_blurred_upload_url_endpoint = f"{BACKEND_SERVER_URL}/get-blurred-upload-url?originalKey={original_key}"
        logger.info(f"Requesting presigned PUT URL for blurred image from: {get_blurred_upload_url_endpoint}")

        upload_url_response = requests.get(get_blurred_upload_url_endpoint)
        upload_url_response.raise_for_status()
        
        presigned_upload_data = upload_url_response.json()
        blurred_s3_upload_url = presigned_upload_data["uploadUrl"]
        blurred_key_for_s3 = presigned_upload_data["blurredKey"] # Get the actual key backend generated
        logger.info(f"✅ Received presigned PUT URL for blurred image: {blurred_key_for_s3}")

        # Upload blurred NIfTI data directly to S3
        logger.info(f"Uploading blurred NIfTI (approx {len(blurred_nifti_bytes)/1024/1024:.2f} MB) directly to S3...")
        s3_upload_response = requests.put(blurred_s3_upload_url, data=blurred_nifti_bytes, headers={
            'Content-Type': 'application/octet-stream' # Ensure correct content type for .nii.gz
        })
        s3_upload_response.raise_for_status()
        logger.info(f"✅ Blurred NIfTI image successfully uploaded to S3: {blurred_key_for_s3}")

        # Emit only notification to backend (no buffer)
        sio.emit("blurred-image-uploaded", {
            "originalKey": original_key,
            "blurredKey": blurred_key_for_s3
        })
        logger.info(f"📤 Sent notification that blurred image {blurred_key_for_s3} is uploaded back to backend.")


        # sio.emit("blurred-image", {
        #     "originalKey": original_key, # Keep originalKey to distinguish in frontend/backend
        #     "buffer": blurred_b64
        # })
        # logger.info(f"📤 Sent blurred data for {original_key} back to backend.")

    except requests.exceptions.RequestException as req_err:
        logger.error(f"❌ HTTP/Network error while getting presigned URL or downloading image: {req_err}", exc_info=True)
    except Exception as e:
        logger.error(f"❌ Error processing image from S3: {e}", exc_info=True)


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
