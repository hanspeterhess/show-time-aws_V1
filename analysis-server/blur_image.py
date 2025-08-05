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
from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
import torch

import nibabel as nib
from scipy.ndimage import gaussian_filter
from os.path import join

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
AI_MODELS_BUCKET_NAME = os.getenv("AI_MODELS_BUCKET_NAME")

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
if not AI_MODELS_BUCKET_NAME:
    logger.error("❌ ERROR: AI_MODELS_BUCKET_NAME environment variable is not set. Exiting.")
    exit(1)


# Initialize SQS clients globally
sqs_client = boto3.client('sqs', region_name=AWS_REGION)






def nnUNetv2_predict(image_dir: str, image_name: str, model_base_s3_folder: str, model_type: str='segmentation', use_folds = [0]) -> str:
    print('image_dir:', image_dir, 'image_name:', image_name, 'model_base_s3_folder:', model_base_s3_folder, 'model_type:', model_type)  
    
    if not os.path.exists(image_dir):
      raise ValueError(f"Image directory '{image_dir}' does not exist")

    segmentation_name = f'{model_type}_{image_name}'
    segmentation_path = join(image_dir, segmentation_name)

    model_download_dir = None
    try:
        model_download_dir = tempfile.TemporaryDirectory()
        local_model_folder_path = join(model_download_dir.name, model_base_s3_folder)
        os.makedirs(local_model_folder_path, exist_ok=True)

        # Define the expected files for nnUNet initialization.
        nnunet_required_files = [
            "dataset.json",
            "dataset_fingerprint.json",
            "plans.json",
        ]

        # Add files for each fold, including the checkpoint
        for fold in use_folds:
            fold_dir = f"fold_{fold}"
            nnunet_required_files.append(f"{fold_dir}/checkpoint_best.pth")

        # Download each required file
        for file_name in nnunet_required_files:
            s3_model_file_key = join(model_base_s3_folder, file_name)
            local_file_path = join(local_model_folder_path, file_name)
            
            # Ensure the local directory structure exists
            os.makedirs(os.path.dirname(local_file_path), exist_ok=True)
            
            # This call will use the s3_client initialized within S3ASService
            s3_as_service.download_file_from_s3(s3_model_file_key, local_file_path)

        model_path_for_nnunet = local_model_folder_path # This is the path nnUNetPredictor expects
        logger.info(f"nnUNet model downloaded and ready at: {model_path_for_nnunet}")

        # Check if GPU is available and log a message
        if torch.cuda.is_available():
            logger.info("✅ CUDA GPU is available. Using GPU for nnUNet inference.")
            device = torch.device('cuda', 0)
        else:
            logger.warning("⚠️ CUDA GPU is NOT available. Falling back to CPU for nnUNet inference.")
            device = torch.device('cpu')

        predictor = nnUNetPredictor(
            use_gaussian=True,
            use_mirroring=False,
            perform_everything_on_device=True,
            device=device,
            verbose=True,
            verbose_preprocessing=True,
            allow_tqdm=True,
        )

        predictor.initialize_from_trained_model_folder(
            model_path_for_nnunet,
            use_folds=use_folds,
            checkpoint_name='checkpoint_best.pth',
        )

        predictor.predict_from_files(
            [ [join(image_dir, image_name)] ],
            [ segmentation_path ],
            save_probabilities=False,
            overwrite=True,
            )

        print(f'Done predicting {model_type} saving to:', segmentation_path)
        return segmentation_path
    
    finally:
        if model_download_dir:
            logger.info(f"Cleaning up temporary model directory: {model_download_dir.name}")
            model_download_dir.cleanup() # This will delete the temporary directory and its contents

# S3 Interaction Service for Analysis Server - Uses requests for presigned URLs
class S3ASService:

    def __init__(self, backend_url, region_name):
        self.backend_url = backend_url
        self.s3_client = boto3.client('s3', region_name=region_name) # Initialize s3_client here!
        logger.info(f"S3ASService initialized with backend URL: {backend_url} and S3 region: {region_name}")

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

    def download_file_from_s3(self, s3_key: str, local_path: str):
        """Downloads a specific file from the AI_MODELS_BUCKET_NAME S3 bucket."""
        logger.info(f"Attempting to download file from s3://{AI_MODELS_BUCKET_NAME}/{s3_key} to {local_path}")
        try:
            self.s3_client.download_file(AI_MODELS_BUCKET_NAME, s3_key, local_path)
            logger.info(f"✅ File successfully downloaded to {local_path}.")
        except Exception as e:
            logger.error(f"❌ Error downloading file {s3_key} from S3 bucket {AI_MODELS_BUCKET_NAME}: {e}", exc_info=True)
            raise # Re-raise to be caught by calling function

# Instantiate the S3ASService instance
# Ensure BACKEND_SERVER_URL and AWS_REGION are set before this
if BACKEND_SERVER_URL and AWS_REGION:
    s3_as_service = S3ASService(BACKEND_SERVER_URL, AWS_REGION)
else:
    logger.error("❌ ERROR: BACKEND_SERVER_URL or AWS_REGION environment variable is not set. S3ASService cannot be initialized.")
    exit(1)

def process_nifti_file(original_key):
    """
    Handles the entire NIfTI blurring process for a given key.
    Returns blurred_key_for_s3 on success, or None on failure.
    """
    try:
         # 1. Download original NIfTI image from S3 using the S3ASService
        original_nifti_bytes = s3_as_service.download_from_s3(original_key)
        
        logger.info(f"Processing NIfTI file: {original_key}")

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_original_nii_file_path = join(temp_dir, os.path.basename(original_key))
            with open(temp_original_nii_file_path, 'wb') as f:
                f.write(original_nifti_bytes)
            logger.info(f"Wrote original NIfTI bytes to temporary file: {temp_original_nii_file_path}")

            # --- Perform nnUNetv2 prediction for segmentation ---
            model_name_for_segmentation = "BoneMuscle_on_T1" # model name
            image_name_for_prediction = os.path.basename(original_key)
            
            segmentation_output_path = nnUNetv2_predict(
                image_dir=temp_dir, 
                image_name=image_name_for_prediction, 
                model_base_s3_folder=model_name_for_segmentation, 
                model_type='segmentation'
            )
            logger.info(f"nnUNetV2 prediction completed. Output saved to: {segmentation_output_path}")

            with open(segmentation_output_path, 'rb') as f:
                segmentation_nifti_bytes = f.read()
            logger.info("✅ Segmentation NIfTI data prepared in bytes format.")

        # 2. Upload blurred NIfTI data directly to S3 using boto3
        blurred_key_for_s3 = s3_as_service.upload_to_s3(original_key, segmentation_nifti_bytes)

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