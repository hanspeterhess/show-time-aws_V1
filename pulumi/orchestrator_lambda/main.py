import json
import os
import boto3
import logging

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

ecs_client = boto3.client('ecs')
sqs_client = boto3.client('sqs')

ECS_CLUSTER_NAME = os.environ.get('ECS_CLUSTER_NAME')
ECS_SERVICE_NAME = os.environ.get('ECS_SERVICE_NAME')

def lambda_handler(event, context):
 logger.info(f"Received event: {json.dumps(event)}")
#  original_key = event.get('originalKey')

#  if not original_key:
#      logger.error("Missing 'originalKey' in event payload.")
#      return {
#          'statusCode': 400,
#          'body': 'Missing originalKey'
#      }

 if not ECS_CLUSTER_NAME or not ECS_SERVICE_NAME:
     logger.error("Missing required environment variables for ECS.")
     return {
         'statusCode': 500,
         'body': 'Lambda configuration error'
     }

 try:
     # 1. Scale up the ECS service if desiredCount is 0
     response = ecs_client.describe_services(
         cluster=ECS_CLUSTER_NAME,
         services=[ECS_SERVICE_NAME]
     )
     current_desired_count = response['services'][0]['desiredCount']
     
     if current_desired_count == 0:
         logger.info(f"Scaling up ECS service {ECS_SERVICE_NAME} to desiredCount: 1")
         ecs_client.update_service(
             cluster=ECS_CLUSTER_NAME,
             service=ECS_SERVICE_NAME,
             desiredCount=1
         )
         logger.info("ECS service scale-up initiated.")
     else:
         logger.info(f"ECS service {ECS_SERVICE_NAME} already running with desiredCount: {current_desired_count}")

     return {
         'statusCode': 200,
         'body': 'ECS service scaled and message sent to SQS'
     }

 except Exception as e:
     logger.error(f"Error in orchestrator Lambda: {e}", exc_info=True)
     return {
         'statusCode': 500,
         'body': f'Error processing request: {str(e)}'
     }