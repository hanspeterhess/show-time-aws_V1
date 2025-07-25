import os
import socketio
import io
import base64
from dotenv import load_dotenv
import time
import logging
import requests
import tempfile 
import json
import time 

import nibabel as nib
from scipy.ndimage import gaussian_filter

import boto3

# Set up basic logging to stdout, which awslogs will capture
logging.basicConfig(
    level=logging.INFO, # Capture INFO, WARNING, ERROR, CRITICAL messages
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

load_dotenv()

# Environment variables (set in Pulumi for ECS task)
SQS_QUEUE_URL = os.getenv("SQS_QUEUE_URL")
BACKEND_CALLBACK_URL = os.getenv("BACKEND_CALLBACK_URL")
BACKEND_SERVER_URL = os.getenv("BACKEND_SERVER_URL")
AWS_REGION = os.getenv("AWS_REGION")

if not SQS_QUEUE_URL:
    logger.error("❌ ERROR: SQS_QUEUE_URL environment variable is not set. Exiting.")
    exit(1)
if not BACKEND_SERVER_URL:
    logger.error("❌ ERROR: BACKEND_SERVER_URL environment variable is not set. Cannot get presigned S3 URLs.")
    exit(1)
if not BACKEND_CALLBACK_URL:
    logger.warning("⚠️ WARNING: BACKEND_CALLBACK_URL environment variable is not set. Cannot notify backend on completion.")
if not AWS_REGION:
    logger.error("❌ ERROR: AWS_REGION environment variable is not set. Exiting.")
    exit(1)
# Initialize SQS clients globally
sqs_client = boto3.client('sqs', region_name=AWS_REGION)


# S3 Interaction Service for Analysis Server - Uses requests for presigned URLs
class S3ASService:
    def __init__(self, backend_url):
        self.backend_url = backend_url

    def _request_presigned_url(self, endpoint, key_param_name, key_value):
        """Helper to request a presigned URL from the backend."""
        url_endpoint = f"{self.backend_url}/{endpoint}?{key_param_name}={key_value}"
        logger.info(f"Requesting presigned URL from: {url_endpoint}")
        response = requests.get(url_endpoint)
        response.raise_for_status()
        return response.json()

    def download_from_s3(self, original_key):
        """Downloads a file from S3 using a presigned GET URL obtained from backend."""
        presigned_data = self._request_presigned_url("get-image-url", "key", original_key)
        image_download_url = presigned_data["url"]
        logger.info("✅ Received presigned GET URL. Downloading image...")

        image_response = requests.get(image_download_url)
        image_response.raise_for_status()
        logger.info("✅ Image downloaded from S3.")
        return image_response.content

    def upload_to_s3(self, original_key, blurred_nifti_bytes):
        """Uploads blurred NIfTI data to S3 using a presigned PUT URL obtained from backend."""
        presigned_upload_data = self._request_presigned_url("get-blurred-upload-url", "originalKey", original_key)
        blurred_s3_upload_url = presigned_upload_data["uploadUrl"]
        blurred_key_for_s3 = presigned_upload_data["blurredKey"]

        logger.info(f"✅ Received presigned PUT URL for blurred image: {blurred_key_for_s3}")
        logger.info(f"Uploading blurred NIfTI (approx {len(blurred_nifti_bytes)/1024/1024:.2f} MB) directly to S3...")

        s3_upload_response = requests.put(blurred_s3_upload_url, data=blurred_nifti_bytes, headers={
            'Content-Type': 'application/octet-stream'
        })
        s3_upload_response.raise_for_status()
        logger.info(f"✅ Blurred NIfTI image successfully uploaded to S3: {blurred_key_for_s3}")
        return blurred_key_for_s3 # Return the key used for S3


# Initialize the S3ASService instance
s3_as_service = S3ASService(BACKEND_SERVER_URL)

def process_nifti_file(original_key):
    """
    Handles the entire NIfTI blurring process for a given key.
    Returns blurred_key_for_s3 on success, or None on failure.
    """
    try:
         # 1. Download original NIfTI image from S3 using the S3ASService
        original_nifti_bytes = s3_as_service.download_from_s3(original_key)
        
        logger.info(f"Processing NIfTI file: {original_key}")

        with tempfile.NamedTemporaryFile(delete=True, suffix='.nii.gz') as temp_original_nii_file:
            temp_original_nii_file.write(original_nifti_bytes)
            temp_original_nii_file.flush()
            temp_original_nii_file_path = temp_original_nii_file.name
            logger.info(f"Wrote original NIfTI bytes to temporary file: {temp_original_nii_file_path}")

            img = nib.load(temp_original_nii_file_path)
            nifti_data = img.get_fdata()

            blurred_nifti_data = gaussian_filter(nifti_data, sigma=3.0)
            blurred_img = nib.Nifti1Image(blurred_nifti_data, img.affine, img.header)

            with tempfile.NamedTemporaryFile(delete=True, suffix='.nii.gz') as temp_blurred_nii_file:
                temp_blurred_nii_file_path = temp_blurred_nii_file.name
                logger.info(f"Saving blurred NIfTI to temporary file: {temp_blurred_nii_file_path}")
                nib.save(blurred_img, temp_blurred_nii_file_path)
                temp_blurred_nii_file.flush()
                temp_blurred_nii_file.seek(0)
                blurred_nifti_bytes = temp_blurred_nii_file.read()
                logger.info("✅ Blurred NIfTI data prepared in bytes format.")

        # 2. Upload blurred NIfTI data directly to S3 using boto3
        blurred_key_for_s3 = s3_as_service.upload_to_s3(original_key, blurred_nifti_bytes)

        return blurred_key_for_s3

    except requests.exceptions.RequestException as req_err:
        logger.error(f"❌ HTTP/Network error during S3 interaction via presigned URLs: {req_err}", exc_info=True)
        return None
    except Exception as e:
        logger.error(f"❌ Generic error during NIfTI processing: {e}", exc_info=True)
        return None

def main_loop():
    logger.info("Starting Analysis Server main loop (polling SQS)...")
    while True:
        try:
            # Poll for messages from SQS
            response = sqs_client.receive_message(
                QueueUrl=SQS_QUEUE_URL,
                MaxNumberOfMessages=1, 
                WaitTimeSeconds=20,    # Long polling (up to 20 seconds)
                VisibilityTimeout=300  # Message invisible for 5 minutes during processing
            )

            messages = response.get('Messages', [])
            if not messages:
                logger.info("No messages in queue. Waiting...")
                continue

            for message in messages:
                receipt_handle = message['ReceiptHandle']
                try:
                    body = json.loads(message['Body'])
                    # SQS messages from Lambda invoke are often double-wrapped JSON
                    # The orchestrator Lambda sends a simple JSON string to SQS
                    # message_content = json.loads(body['Message']) # SQS messages from Lambda invoke are wrapped
                    # original_key = message_content.get('originalKey')
                    original_key = body.get('originalKey') 

                    if not original_key:
                        logger.error(f"Message missing 'originalKey': {message['Body']}. Deleting message.")
                        sqs_client.delete_message(
                            QueueUrl=SQS_QUEUE_URL,
                            ReceiptHandle=receipt_handle
                        )
                        continue

                    logger.info(f"Received message for originalKey: {original_key}")

                    blurred_key = process_nifti_file(original_key)

                    if BACKEND_CALLBACK_URL:
                        try:
                            callback_payload = { "originalKey": original_key }
                            if blurred_key:
                                callback_payload["blurredKey"] = blurred_key
                            else:
                                callback_payload["error"] = "NIfTI processing failed in AS."

                            logger.info(f"Sending completion/error callback to backend: {BACKEND_CALLBACK_URL} with payload: {callback_payload}")
                            requests.post(BACKEND_CALLBACK_URL, json=callback_payload)
                            logger.info("✅ Completion/error callback sent to backend.")
                        except requests.exceptions.RequestException as e:
                            logger.error(f"❌ Failed to send completion/error callback to backend: {e}", exc_info=True)
                    else:
                        logger.warning("Backend callback URL not set, skipping completion callback.")

                    # Delete message from queue only after successful processing and callback
                    if blurred_key: # Only delete if processing was successful
                        sqs_client.delete_message(
                            QueueUrl=SQS_QUEUE_URL,
                            ReceiptHandle=receipt_handle
                        )
                        logger.info(f"✅ Message deleted from SQS queue for {original_key}.")
                    else:
                        logger.error(f"Processing failed for {original_key}. Not deleting message from queue.")

                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse SQS message body: {message['Body']}. Error: {e}. Deleting message.", exc_info=True)
                    sqs_client.delete_message(
                        QueueUrl=SQS_QUEUE_URL,
                        ReceiptHandle=receipt_handle
                    )
                except Exception as e:
                    logger.error(f"Unhandled error processing SQS message: {e}", exc_info=True)
                    # Message will become visible again after VisibilityTimeout if not deleted
        except Exception as e:
            logger.error(f"❌ Error in main SQS polling loop: {e}", exc_info=True)
            time.sleep(10) # Wait before retrying polling loop

if __name__ == "__main__":
    main_loop()

# sio = socketio.Client()

# # S3 Interaction Service for Analysis Server
# class S3ASService:
#     def __init__(self, backend_url):
#         self.backend_url = backend_url

#     def _request_presigned_url(self, endpoint, key_param_name, key_value):
#         """Helper to request a presigned URL from the backend."""
#         url_endpoint = f"{self.backend_url}/{endpoint}?{key_param_name}={key_value}"
#         logger.info(f"Requesting presigned URL from: {url_endpoint}")
#         response = requests.get(url_endpoint)
#         response.raise_for_status()
#         return response.json()

#     def download_from_s3(self, original_key):
#         """Downloads a file from S3 using a presigned GET URL."""
#         presigned_data = self._request_presigned_url("get-image-url", "key", original_key)
#         image_download_url = presigned_data["url"]
#         logger.info("✅ Received presigned GET URL. Downloading image...")

#         image_response = requests.get(image_download_url)
#         image_response.raise_for_status()
#         logger.info("✅ Image downloaded from S3.")
#         return image_response.content

#     def upload_to_s3(self, original_key, blurred_nifti_bytes):
#         """Uploads blurred NIfTI data to S3 using a presigned PUT URL."""
#         presigned_upload_data = self._request_presigned_url("get-blurred-upload-url", "originalKey", original_key)
#         blurred_s3_upload_url = presigned_upload_data["uploadUrl"]
#         blurred_key_for_s3 = presigned_upload_data["blurredKey"]

#         logger.info(f"✅ Received presigned PUT URL for blurred image: {blurred_key_for_s3}")
#         logger.info(f"Uploading blurred NIfTI (approx {len(blurred_nifti_bytes)/1024/1024:.2f} MB) directly to S3...")

#         s3_upload_response = requests.put(blurred_s3_upload_url, data=blurred_nifti_bytes, headers={
#             'Content-Type': 'application/octet-stream'
#         })
#         s3_upload_response.raise_for_status()
#         logger.info(f"✅ Blurred NIfTI image successfully uploaded to S3: {blurred_key_for_s3}")
#         return blurred_key_for_s3 # Return the key used for S3


# s3_as_service = S3ASService(BACKEND_SERVER_URL)

# @sio.event
# def connect():
#     logger.info(f"✅ SIO Event: Connected to backend at {BACKEND_SERVER_URL}")
#     sio.emit("identify", {"role": "python-client"})

# @sio.event
# def disconnect():
#     logger.warning("❌ SIO Event: Disconnected from backend")

# @sio.event
# def connect_error(data):
#     logger.error(f"❌ SIO Event: Connection failed: {data}")

# @sio.on("blur-image")
# def on_blur_image(data):
#     logger.info("🖼️ Received image for blurring")
#     original_key = data["originalKey"]

#     try:
#         # Download original NIfTI image from S3
#         original_nifti_bytes = s3_as_service.download_from_s3(original_key)

#         logger.info(f"Processing NIfTI file: {original_key}")

#         with tempfile.NamedTemporaryFile(delete=True, suffix='.nii.gz') as temp_nii_file:
#             temp_nii_file.write(original_nifti_bytes) 
#             temp_nii_file.flush()
#             temp_nii_file_path = temp_nii_file.name
#             logger.info(f"Wrote NIfTI bytes to temporary file: {temp_nii_file_path}")

#             try:
#                 img = nib.load(temp_nii_file_path)
#                 nifti_data = img.get_fdata()

#                 blurred_nifti_data = gaussian_filter(nifti_data, sigma=3.0)
#                 blurred_img = nib.Nifti1Image(blurred_nifti_data, img.affine, img.header)

#                 with tempfile.NamedTemporaryFile(delete=True, suffix='.nii.gz') as temp_blurred_nii_file:
#                         temp_blurred_nii_file_path = temp_blurred_nii_file.name
#                         logger.info(f"Saving blurred NIfTI to temporary file: {temp_blurred_nii_file_path}")
#                         nib.save(blurred_img, temp_blurred_nii_file_path)
#                         temp_blurred_nii_file.flush()
#                         temp_blurred_nii_file.seek(0)
#                         blurred_nifti_bytes = temp_blurred_nii_file.read()
#                         logger.info("✅ Blurred 3D NIfTI data prepared from temporary file")

#             except Exception as load_err:
#                 logger.error(f"❌ Error loading NIfTI from temporary file {temp_nii_file_path}: {load_err}", exc_info=True)
#                 # If loading fails, we should not proceed with emitting blurred data
#                 return
            
        
#         # Upload blurred NIfTI data directly to S3
#         blurred_key_for_s3 = s3_as_service.upload_to_s3(original_key, blurred_nifti_bytes)

#         # Emit only notification to backend (no buffer)
#         sio.emit("blurred-image-uploaded", {
#             "originalKey": original_key,
#             "blurredKey": blurred_key_for_s3
#         })
#         logger.info(f"📤 Sent notification that blurred image {blurred_key_for_s3} is uploaded back to backend.")

#     except requests.exceptions.RequestException as req_err:
#         logger.error(f"❌ HTTP/Network error while getting presigned URL or downloading image: {req_err}", exc_info=True)
#     except Exception as e:
#         logger.error(f"❌ Error processing image from S3: {e}", exc_info=True)


# def main():
#     while True:
#         try:
#             logger.info(f"🔌 Attempting connection to {BACKEND_SERVER_URL}...")
#             sio.connect(BACKEND_SERVER_URL)
#             logger.info("--- AS Main Loop: sio.connect() call returned successfully. Entering wait state. ---")
#             sio.wait() # This blocks the main thread until disconnect or error
#         except Exception as e:
#             logger.error(f"⚠️ Connection error in main loop: {e}", exc_info=True)
#             logger.info("🔁 Retrying connection in 5 seconds...")
#             time.sleep(5)


# if __name__ == "__main__":
#     main()
