import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as fs from "fs";
import * as path from "path";
import * as docker from "@pulumi/docker";
import * as docker_build from "@pulumi/docker-build"; //


// --- Configuration ---
const config = new pulumi.Config();
const region = aws.config.region || "eu-central-1";

// Subdomain for backend API (e.g., 'api.aikeso.com')
const backendApiDomainName = config.require("backendApiDomainName");

// Image tags for backend and analysis server, defaulting to "latest" if not specified
const backendImageTag = config.get("backendImageTag") || "b_latest";
const asImageTag = config.get("asImageTag") || "as_latest";
const auth0IssuerBaseUrl = config.get("auth0IssuerBaseUrl");
if (!auth0IssuerBaseUrl) {
    throw new Error("auth0IssuerBaseUrl is not set in Pulumi config. Please set it with 'pulumi config set auth0IssuerBaseUrl <your-auth0-issuer-url>'");
}
if (auth0IssuerBaseUrl.startsWith("http")) {
    throw new Error("auth0IssuerBaseUrl should not start with 'http://' or 'https://'. Please provide the domain only, e.g., 'dev-xyz.us.auth0.com'");
}

// --- SSH Key Pair for EC2 Instances ---
const homeDir = process.env.HOME || process.env.USERPROFILE || ""; // Covers Linux, macOS, Windows
const pubKeyPath = path.join(homeDir, ".ssh", "ecs-key.pub");
if (!fs.existsSync(pubKeyPath)) {
    throw new Error(`SSH public key not found at ${pubKeyPath}. Please generate one with 'ssh-keygen -t rsa -b 4096 -f ~/.ssh/ecs-key'`);
}
const keyPair = new aws.ec2.KeyPair("ecs-keypair", {
    publicKey: fs.readFileSync(pubKeyPath, "utf-8"),
});

// DynamoDB Table
const table = new aws.dynamodb.Table("timeStampsTable", {
    attributes: [{ name: "id", type: "S" }],
    hashKey: "id",
    billingMode: "PAY_PER_REQUEST",
    tags: {
        Environment: "dev",
        Project: "TimeStoreApp",
    },
});

// --- ECR Repositories ---
const backendRepo = new aws.ecr.Repository("backend-repo", {
    forceDelete: true,
    tags: { Project: "orthelot"},
});

const asRepo = new aws.ecr.Repository("analysis-server-repo", {
    forceDelete: true,
    tags: { Project: "orthelot"},
});

// // --- Docker Images for ECR ---
// const backendImage = new docker.Image("backend-image", {
//     imageName: pulumi.interpolate`${backendRepo.repositoryUrl}:${backendImageTag}`,
//     build: {
//         context: "../backend",
//         dockerfile: "../backend/Dockerfile.backend",
//         platform: "linux/amd64",
//         // Use noCache to ensure we always build the latest image
//         noCache: true,
//     },
//     registry: backendRepo.repositoryUrl.apply(repoUrl => {
//         const server = repoUrl.split("/")[0];
//         return aws.ecr.getCredentialsOutput({ registryId: backendRepo.registryId }).apply(creds => {
//             const decodedCreds = Buffer.from(creds.authorizationToken, "base64").toString();
//             const [username, password] = decodedCreds.split(":");
//             return {server, username, password };
//         });
//     }),
// });

const backendImage = new docker_build.Image("backend-image", {
    // Note: The `imageName` property might be different,
    // often specified via `tags` and `exports`.
    // The `docker-build` provider is more aligned with BuildKit's `docker buildx build`
    // which pushes to a registry if `push: true` is set, and uses `tags`.

    tags: [pulumi.interpolate`${backendRepo.repositoryUrl}:${backendImageTag}`],
    context: {
        location: "../backend", // This is the path to your build context
    },
    dockerfile: {
        location: "../backend/Dockerfile.backend", // Relative to the 'context.location'
    },
    platforms: ["linux/amd64"],
    noCache: true, // This is the property you were looking for!
    push: true, // Crucial to push the image to ECR
    registries: [
        backendRepo.repositoryUrl.apply(repoUrl => {
            const address = repoUrl.split("/")[0]; // ECR repository URL typically includes the server address
            return aws.ecr.getCredentialsOutput({ registryId: backendRepo.registryId }).apply(creds => {
                const decodedCreds = Buffer.from(creds.authorizationToken, "base64").toString();
                const [username, password] = decodedCreds.split(":");
                return {
                    address: address, // Use 'address' here
                    username: username,
                    password: password,
                };
            });
        }),
    ],

    // You might also need this if your Dockerfile depends on an external image update
    // pull: true, // Forces pulling the base image every time
});
// const asImageTag = `latest-${new Date().getTime()}`;

const asImage = new docker.Image("as-image", {
    imageName: pulumi.interpolate`${asRepo.repositoryUrl}:${asImageTag}`,
    build: {
        context: "../analysis-server",
        dockerfile: "../analysis-server/Dockerfile.as", 
        platform: "linux/amd64",
    },
    registry: asRepo.repositoryUrl.apply(repoUrl => {
        const server = repoUrl.split("/")[0];
        return aws.ecr.getCredentialsOutput({ registryId: asRepo.registryId }).apply(creds => {
            const decodedCreds = Buffer.from(creds.authorizationToken, "base64").toString();
            const [username, password] = decodedCreds.split(":");
            return {server, username, password };
        });
    }),
});

// --- VPC and ECS Cluster ---
const vpc = new awsx.ec2.Vpc("ecs-vpc", {
    numberOfAvailabilityZones: 2,
    natGateways: {
        strategy: "Single", // Use a single NAT Gateway for cost-efficiency
    }
});

const appCluster = new aws.ecs.Cluster("app-cluster", {
    name: "app-cluster",
});

// --- IAM Roles and Policies ---

// Shared ECS Task Execution Role for Backend and Analysis Server
const ecsTaskRole = new aws.iam.Role("ecsTaskRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ecs-tasks.amazonaws.com" }),
});

// Attach basic ECS execution policy 
new aws.iam.RolePolicyAttachment("ecs-task-exec-policy", {
    role: ecsTaskRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
});

// DynamoDB Access Policy for ECS tasks (Backend)
const ecsDynamoDBAccessPolicy = new aws.iam.RolePolicy("ecsDynamoDBAccessPolicy", {
    role: ecsTaskRole.id,
    policy: table.arn.apply(arn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "dynamodb:PutItem",
                    "dynamodb:GetItem",
                    "dynamodb:Query",
                    "dynamodb:Scan",
                    "dynamodb:UpdateItem",
                    "dynamodb:DeleteItem"
                ],
                Resource: arn,
            },
        ],
    })),
});

// S3 Bucket
const bucket = new aws.s3.Bucket("uploadBucket", {
    forceDestroy: true, // deletes even non-empty buckets
    tags: { Project: "TimeStoreApp" },
});

// S3 CORS configuration for the upload bucket
const bucketCors = new aws.s3.BucketCorsConfigurationV2("upload-bucket-cors", {
    bucket: bucket.id,
    corsRules: [{
        allowedHeaders: ["*"], // Allow all headers
        // allowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"], // Methods allowed from your frontend
        allowedMethods: ["GET", "PUT", "POST", "DELETE"], // Methods allowed from your frontend
        allowedOrigins: [
            "https://dev-t.aikeso.com",
            "https://www.dev-t.aikeso.com",
            "http://localhost:3000" // If you test locally
        ],
        exposeHeaders: [],
        maxAgeSeconds: 3000,
    }],
});

// Consolidated S3 Policy for ECS Task Role (Backend & AS)
const ecsS3Policy = new aws.iam.Policy("ecs-s3-policy", {
    description: "Allows ECS tasks to interact with the S3 upload bucket",
    policy: pulumi.all([bucket.arn]).apply(([bucketArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "s3:PutObject",
                    "s3:GetObject",
                    "s3:HeadObject",
                ],
                Resource: `${bucketArn}/*`,
            },
        ],
    })),
});

new aws.iam.RolePolicyAttachment("ecs-s3-policy-attachment", {
    role: ecsTaskRole.name,
    policyArn: ecsS3Policy.arn,
});

// S3 Bucket for AI Models
const aiModelsBucket = new aws.s3.Bucket("aiModelsBucket", {
    // It's good practice to prevent accidental deletion of important model data
    forceDestroy: true, // Consider removing this for production models
});


// IAM Policy for AS tasks to access the AI Models S3 bucket
const aiModelsS3AccessPolicy = new aws.iam.Policy("ai-models-s3-access-policy", {
    description: "Allows ECS tasks to read from the AI Models S3 bucket",
    policy: aiModelsBucket.arn.apply(arn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "s3:GetObject",
                    "s3:ListBucket", // Often useful to list contents if models are in subfolders
                ],
                Resource: [
                    arn,      // Permission for the bucket itself (for ListBucket)
                    `${arn}/*`, // Permission for objects within the bucket (for GetObject)
                ],
            },
        ],
    })),
});

// Attach AI Models S3 access policy to the shared ECS Task Role
new aws.iam.RolePolicyAttachment("ecs-ai-models-s3-access-policy-attachment", {
    role: ecsTaskRole.name,
    policyArn: aiModelsS3AccessPolicy.arn,
});


// SQS Queue for Analysis Server tasks to poll
const asProcessingQueue = new aws.sqs.Queue("as-processing-queue", {
    visibilityTimeoutSeconds: 300, // Tasks have 5 minutes to process
    messageRetentionSeconds: 86400, // Keep messages for 1 day
    tags: { Project: "TimeStoreApp" },
});

// IAM Policy for AS tasks to poll SQS
const asSqsPolicy = new aws.iam.Policy("as-sqs-policy", {
    description: "Allows AS tasks to poll and delete messages from SQS queue",
    policy: asProcessingQueue.arn.apply(arn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "sqs:ReceiveMessage",
                    "sqs:DeleteMessage",
                    "sqs:ChangeMessageVisibility",
                    "sqs:GetQueueUrl", // Often needed
                    "sqs:GetQueueAttributes" // Often needed
                ],
                Resource: arn,
            },
        ],
    })),
});

// Attach SQS policy to the general ECS Task Role
new aws.iam.RolePolicyAttachment("ecs-as-sqs-policy-attachment", {
    role: ecsTaskRole.name, // Attach to the shared ecsTaskRole
    policyArn: asSqsPolicy.arn,
});

// Add SQS send permissions to the shared ecsTaskRole for the backend
const backendSqsSendPolicy = new aws.iam.Policy("backend-sqs-send-policy", {
    description: "Allows backend ECS tasks to send messages to SQS queue",
    policy: asProcessingQueue.arn.apply(arn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: "sqs:SendMessage",
            Resource: arn,
        }],
    })),
});

// Attach SQS send policy to the shared ECS Task Role (if backend sends SQS messages)
new aws.iam.RolePolicyAttachment("ecs-backend-sqs-send-policy-attachment", {
    role: ecsTaskRole.name,
    policyArn: backendSqsSendPolicy.arn,
});


// --- Load Balancer for Backend ---
const lbSg = new aws.ec2.SecurityGroup("lb-sg", {
    vpcId: vpc.vpc.id,
    description: "Allow HTTP and HTTPS access to Load Balancer",
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

const sg = new aws.ec2.SecurityGroup("ecs-sg", {
    vpcId: vpc.vpc.id,
    description: "Allow HTTP and SSH access",
    ingress: [
        { protocol: "tcp", fromPort: 4000, toPort: 4000, securityGroups: [lbSg.id] },
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] }, // Allow SSH from anywhere (OK for dev)
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

const asTaskSg = new aws.ec2.SecurityGroup("as-task-sg", {
    vpcId: vpc.vpc.id,
    description: "Security Group for AS tasks in private subnets",
    ingress: [],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }], // Allow outbound to internet (via NAT)
});


// --- CloudWatch Log Groups ---
const backendLogGroup = new aws.cloudwatch.LogGroup("ecs-backend-log-group");
const asLogGroup = new aws.cloudwatch.LogGroup("ecs-as-log-group");

// --- EC2 Instance Role for ECS Agent ---
const ecsInstanceRole = new aws.iam.Role("ecsInstanceRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
});

new aws.iam.RolePolicyAttachment("ecsInstancePolicy", {
    role: ecsInstanceRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonEC2ContainerServiceforEC2Role,
});

const instanceProfile = new aws.iam.InstanceProfile("ecsInstanceProfile", {
    role: ecsInstanceRole.name,
});

// get ECS optimized AMI
const ami_backend = aws.ec2.getAmi({
    filters: [
        { name: "name", values: ["amzn2-ami-ecs-hvm-*-x86_64-ebs"] },
        { name: "owner-alias", values: ["amazon"] },
    ],
    mostRecent: true,
});

// get ECS optimized AMI
const ami_as = aws.ec2.getAmi({
    filters: [
        { name: "name", values: ["amzn2-ami-ecs-gpu-hvm-*-x86_64-ebs"] },
        { name: "owner-alias", values: ["amazon"] },
    ],
    mostRecent: true,
});

// User data for ECS instances to join the cluster
const ecsUserData = appCluster.name.apply(clusterName =>
    Buffer.from(`#!/bin/bash
echo ECS_CLUSTER=${clusterName} >> /etc/ecs/ecs.config
echo ECS_CONTAINER_INSTANCE_TAGS='{"Project": "TimeStoreApp", "Role": "backend"}' >> /etc/ecs/ecs.config
`).toString("base64")
);

const asEcsUserData = appCluster.name.apply(clusterName =>
    Buffer.from(`#!/bin/bash
echo ECS_CLUSTER=${clusterName} >> /etc/ecs/ecs.config
echo ECS_CONTAINER_INSTANCE_TAGS='{"Project": "TimeStoreApp", "Role": "analysis-server"}' >> /etc/ecs/ecs.config
`).toString("base64")
);

// --- Launch Templates ---
const backendLaunchTemplate = new aws.ec2.LaunchTemplate("ecs-backend-launch-template", {
    imageId: ami_backend.then(a => a.id),
    instanceType: "t3.micro",
    keyName: keyPair.keyName,
    iamInstanceProfile: { name: instanceProfile.name, },
    vpcSecurityGroupIds: [sg.id],
    userData: ecsUserData,
    tagSpecifications: [{
        resourceType: "instance",
        tags: { Name: "ecs-backend-instance" },
    }],
});

const asLaunchTemplate = new aws.ec2.LaunchTemplate("ecs-as-launch-template", {
    imageId: ami_as.then(a => a.id),
    instanceType: "g4dn.xlarge", 
    keyName: keyPair.keyName,
    iamInstanceProfile: { name: instanceProfile.name, },
    vpcSecurityGroupIds: [asTaskSg.id], // AS tasks use their own SG
    userData: asEcsUserData, // Use shared ECS user data
    tagSpecifications: [{
        resourceType: "instance",
        tags: { Name: "ecs-as-instance", Role: "analysis-server" },
    }],
});

// --- Auto Scaling Group for Backend ---
const backendAutoScalingGroup = new aws.autoscaling.Group("ecs-backend-asg", {
    vpcZoneIdentifiers: vpc.publicSubnetIds,
    minSize: 1,
    maxSize: 1,
    desiredCapacity: 1,
    launchTemplate: { id: backendLaunchTemplate.id, version: "$Latest" },
    tags: [{ key: "Name", value: "ecs-backend-instance", propagateAtLaunch: true }],
});

const lb = new aws.lb.LoadBalancer("socket-io-lb", {
    internal: false,
    securityGroups: [lbSg.id],
    subnets: vpc.publicSubnetIds,
    loadBalancerType: "application",
});

const backendTargetGroup = new aws.lb.TargetGroup("backend-tg", {
    port: 4000, 
    protocol: "HTTP", 
    targetType: "instance",
    vpcId: vpc.vpc.id,
    healthCheck: {
        path: "/health", 
        protocol: "HTTP",
        matcher: "200",
        interval: 30,
        timeout: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
    },
    stickiness: {
        enabled: true,
        type: "lb_cookie",
        cookieDuration: 86400, // 1 day in seconds
    },
});

// Request an ACM Certificate using DNS validation for your backend API subdomain
const certificate = new aws.acm.Certificate("backend-api-cert", {
    domainName: backendApiDomainName, // e.g. 'api.aikeso.com'
    validationMethod: "DNS",
});

// NEW: This resource is crucial. It tells Pulumi to wait for the ACM certificate
// to be validated (i.e., the DNS CNAME record for validation to be present and propagated).
// Without this, Pulumi might try to use the certificate before it's "Issued".
const certificateValidation = new aws.acm.CertificateValidation("backend-api-cert-validation", {
    certificateArn: certificate.arn,
    // The validationRecords property contains the CNAME record details needed for DNS validation.
    // Pulumi will expect these to exist in your Route 53 hosted zone.
    validationRecordFqdns: [certificate.domainValidationOptions[0].resourceRecordName],
    }, { dependsOn: [certificate] });


// Create a Listener for the Load Balancer on HTTPS (port 443)
const lbListenerHttps = new aws.lb.Listener("backend-listener-https", {
    loadBalancerArn: lb.arn,
    port: 443, // Standard HTTPS port
    protocol: "HTTPS",
    sslPolicy: "ELBSecurityPolicy-2016-08", // Recommended SSL policy
    certificateArn: certificate.arn, // Use the ACM certificate
    defaultActions: [{ type: "forward", targetGroupArn: backendTargetGroup.arn, }],
});

const lbListenerHttpRedirect = new aws.lb.Listener("backend-listener-http-redirect", {
    loadBalancerArn: lb.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{
        type: "redirect",
        redirect: {
            port: "443",
            protocol: "HTTPS",
            statusCode: "HTTP_301", // Permanent redirect
        },
    }],
});


// --- ECS Task Definition for Analysis Server (AS) ---
const asTaskDefinition = new aws.ecs.TaskDefinition("ecs-as-task", {
    family: "as-task",
    cpu: "4096", // 4 vCPUs
    memory: "12288", // 12 GiB
    networkMode: "bridge",
    requiresCompatibilities: ["EC2"],
    executionRoleArn: ecsTaskRole.arn,
    taskRoleArn: ecsTaskRole.arn,
    containerDefinitions: pulumi.all([
        asImage.imageName,
        asLogGroup.name,
        asProcessingQueue.url,
        backendApiDomainName,
        aiModelsBucket.bucket,
    ]).apply(([imageName, logGroupName, sqsQueueUrl, apiDomainName, aiModelsBucketName]) =>
        JSON.stringify([
            {
                name: "analysis-server",
                image: imageName,
                essential: true,
                logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                        "awslogs-group": logGroupName,
                        "awslogs-region": region,
                        "awslogs-stream-prefix": "ecs",
                    },
                },
                environment: [
                    { name: "SQS_QUEUE_URL", value: sqsQueueUrl },
                    { name: "BACKEND_CALLBACK_URL", value: `https://${apiDomainName}/blurred-image-callback` },
                    { name: "BACKEND_SERVER_URL", value: `https://${apiDomainName}` },
                    { name: "AWS_REGION", value: region },
                    { name: "AI_MODELS_BUCKET_NAME", value: aiModelsBucketName },
                ],
                resourceRequirements: [{
                    type: "GPU",
                    value: "1",
                }],
            },
        ])
    ),
});




// --- Auto Scaling for Analysis Server (AS) ---

// Auto Scaling Group for analysis server (as)
const asAutoScalingGroup = new aws.autoscaling.Group("ecs-as-asg", {
    vpcZoneIdentifiers: vpc.privateSubnetIds,
    minSize: 0, // Min size 0 for on-demand scaling
    maxSize: 1,
    desiredCapacity: 1, // Desired capacity 0
    launchTemplate: { id: asLaunchTemplate.id, version: "$Latest" },
    protectFromScaleIn: true, // Prevent ASG from scaling in automatically
    tags: [
        { key: "Name", value: "ecs-as-instance", propagateAtLaunch: true },
        { key: "Role", value: "analysis-server", propagateAtLaunch: true }
    ],
});

// ECS Capacity Provider for AS Auto Scaling Group
const asCapacityProvider = new aws.ecs.CapacityProvider("as-capacity-provider", {
    autoScalingGroupProvider: {
        autoScalingGroupArn: asAutoScalingGroup.arn,
        managedScaling: {
            status: "ENABLED",
            targetCapacity: 100, // Maintain 100% utilization of instances in ASG
        },
        managedTerminationProtection: "ENABLED", // Protect instances from accidental termination
    },
    tags: { Project: "TimeStoreApp", Role: "analysis-server" },
});


// Associate Capacity Providers with the Cluster
// This tells the ECS cluster which ASGs it can use for capacity.
const clusterCapacityProviders = new aws.ecs.ClusterCapacityProviders("app-cluster-capacity-providers", {
    clusterName: appCluster.name,
    capacityProviders: [
        asCapacityProvider.name, // Add the AS capacity provider
        // If you had a backend capacity provider, you'd add it here too:
        // backendCapacityProvider.name,
    ],
    defaultCapacityProviderStrategies: [
        {
            capacityProvider: asCapacityProvider.name,
            weight: 1,
            base: 0,
        },
        // You might define a default strategy for backend if you have a backend CP
    ],
}, { dependsOn: [asCapacityProvider] });

// --- ECS Service for Analysis Server (AS) - Scaled to Zero ---
const asService = new aws.ecs.Service("ecs-as-service", {
    cluster: appCluster.arn,
    desiredCount: 0, // Start with 0 instances
    taskDefinition: asTaskDefinition.arn,
    deploymentMinimumHealthyPercent: 0,
    deploymentMaximumPercent: 100,
    networkConfiguration: undefined, // bridge mode
    capacityProviderStrategies: [{
        capacityProvider: asCapacityProvider.name, // Use the dedicated AS capacity provider
        weight: 1, // All tasks should use this capacity provider
        base: 0, // Start with 0 tasks on this capacity provider
    }],
    // IMPORTANT: Ensure this dependsOn is correctly placed as the third argument
}, { dependsOn: [clusterCapacityProviders] });

const asScalableTarget = new aws.appautoscaling.Target("as-scalable-target", {
    maxCapacity: 1, // Max number of AS tasks
    minCapacity: 0, // Min number of AS tasks
    resourceId: pulumi.interpolate`service/${appCluster.name}/${asService.name}`,
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
});

// const asSqsScalingPolicy = new aws.appautoscaling.Policy("as-sqs-scaling-policy", {
//     policyType: "StepScaling",
//     resourceId: asScalableTarget.resourceId,
//     scalableDimension: asScalableTarget.scalableDimension,
//     serviceNamespace: asScalableTarget.serviceNamespace,
//     stepScalingPolicyConfiguration: {
//         adjustmentType: "ChangeInCapacity",
//         cooldown: 60, // Cooldown period in seconds
//         stepAdjustments: [
//             { metricIntervalUpperBound: "0", scalingAdjustment: -1 }, // If queue has 0 messages, scale down by 1
//             { metricIntervalLowerBound: "0", scalingAdjustment: 1 }, // If queue has > 0 messages, scale up by 1
//         ],
//     },
// });

const asSqsScalingUpPolicy = new aws.appautoscaling.Policy("as-sqs-scaling-up-policy", {
    policyType: "StepScaling",
    resourceId: asScalableTarget.resourceId,
    scalableDimension: asScalableTarget.scalableDimension,
    serviceNamespace: asScalableTarget.serviceNamespace,
    stepScalingPolicyConfiguration: {
        adjustmentType: "ChangeInCapacity",
        cooldown: 60, // Cooldown period in seconds
        stepAdjustments: [
            // This policy only handles scaling UP
            { metricIntervalLowerBound: "0", scalingAdjustment: 1 }, // If metric > 0, scale up by 1
        ],
    },
});

const asSqsScalingDownPolicy = new aws.appautoscaling.Policy("as-sqs-scaling-down-policy", {
    policyType: "StepScaling",
    resourceId: asScalableTarget.resourceId,
    scalableDimension: asScalableTarget.scalableDimension,
    serviceNamespace: asScalableTarget.serviceNamespace,
    stepScalingPolicyConfiguration: {
        adjustmentType: "ChangeInCapacity",
        cooldown: 300, // Often use a longer cooldown for scale-down to prevent rapid cycling
        stepAdjustments: [
            // This policy only handles scaling DOWN
            { metricIntervalUpperBound: "0", scalingAdjustment: -1 }, // If metric <= 0, scale down by 1
        ],
    },
});
const asQueueDepthAlarm = new aws.cloudwatch.MetricAlarm("as-queue-depth-alarm", {
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    evaluationPeriods: 1,
    metricName: "ApproximateNumberOfMessagesVisible",
    namespace: "AWS/SQS",
    period: 60, // 1 minute
    statistic: "Average",
    threshold: 1, // Trigger if 1 or more messages are visible
    alarmDescription: "Alarm when SQS queue has messages, to scale up AS service",
    dimensions: { QueueName: asProcessingQueue.name},
    alarmActions: [asSqsScalingUpPolicy.arn], 
});

const asQueueEmptyAlarm = new aws.cloudwatch.MetricAlarm("as-queue-empty-alarm", {
    comparisonOperator: "LessThanOrEqualToThreshold",
    evaluationPeriods: 10, // Evaluate over 5 minutes
    metricName: "NumberOfMessagesSent",
    namespace: "AWS/SQS",
    period: 60,
    statistic: "Maximum",
    threshold: 0, // Trigger if queue is empty
    alarmDescription: "Alarm when SQS queue is empty, to scale down AS service",
    dimensions: { QueueName: asProcessingQueue.name },
    alarmActions: [asSqsScalingDownPolicy.arn], 
});

// --- AWS Lambda Function for Orchestration ---
const orchestratorLambdaRole = new aws.iam.Role("orchestrator-lambda-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});

// Attach policies for Lambda execution and ECS service scaling
new aws.iam.RolePolicyAttachment("orchestrator-lambda-exec-policy", {
    role: orchestratorLambdaRole.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

new aws.iam.RolePolicyAttachment("orchestrator-lambda-ecs-scale-policy", {
    role: orchestratorLambdaRole.name,
    policyArn: new aws.iam.Policy("orchestrator-ecs-scale-policy", {
        description: "Allows orchestrator Lambda to scale ECS service",
        policy: pulumi.all([
            appCluster.name,
            asService.name,
            appCluster.arn,
            aws.getRegionOutput().name, // Get the region as a resolved string
            aws.getCallerIdentityOutput().accountId // Get the account ID as a resolved string
        ]).apply(([clusterName, serviceName, clusterArn, region, accountId]) => JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: [
                    "ecs:UpdateService",    
                    "ecs:DescribeServices" 
                ],
                Resource: `arn:aws:ecs:${region}:${accountId}:service/${clusterName}/${serviceName}`,
                Condition: {
                    ArnEquals: {
                        "ecs:cluster": clusterArn,
                    },
                },
            }],
        })),
    }).arn,
});


new aws.iam.RolePolicyAttachment("orchestrator-lambda-sqs-send-policy", {
    role: orchestratorLambdaRole.name,
    policyArn: new aws.iam.Policy("orchestrator-sqs-send-policy", {
        description: "Allows orchestrator Lambda to send messages to SQS",
        policy: asProcessingQueue.arn.apply(arn => JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: "sqs:SendMessage",
                Resource: arn,
            }],
        })),
    }).arn,
});

// Path to the directory containing orchestrator Lambda Python code
const orchestratorCodeDir = "./orchestrator_lambda";

const orchestratorLambda = new aws.lambda.Function("orchestrator-lambda", {
     code: new pulumi.asset.FileArchive(orchestratorCodeDir), // Use FileArchive to zip the directory
    runtime: aws.lambda.Runtime.Python3d10, // Use the latest Python 3 runtime
    handler: "main.lambda_handler", // Handler is 'filename.function_name' (e.g., main.py -> main.lambda_handler)
    role: orchestratorLambdaRole.arn,
    timeout: 30,
    memorySize: 128,
    environment: {
        variables: {
            "ECS_CLUSTER_NAME": appCluster.name,
            "ECS_SERVICE_NAME": asService.name,
        },
    },
});

// Policy to allow ECS tasks (backend) to invoke the orchestrator Lambda
new aws.iam.RolePolicyAttachment("ecs-lambda-invoke-policy", {
    role: ecsTaskRole.name,
    policyArn: new aws.iam.Policy("ecs-lambda-invoke-policy", {
        description: "Allows ECS tasks to invoke the orchestrator Lambda function",
        policy: orchestratorLambda.arn.apply(arn => JSON.stringify({
            Version: "2012-10-17",
            Statement: [{
                Effect: "Allow",
                Action: "lambda:InvokeFunction",
                Resource: arn, // The ARN of your orchestrator Lambda
            }],
        })),
    }).arn,
});

// --- ECS Task Definition for Backend ---
const backendTaskDefinition = new aws.ecs.TaskDefinition("ecs-backend-task", {
    family: "backend-task",
    networkMode: "bridge",
    cpu: "256",
    memory: "512",
    requiresCompatibilities: ["EC2"],
    executionRoleArn: ecsTaskRole.arn,
    taskRoleArn: ecsTaskRole.arn,    
    containerDefinitions: pulumi.all([
        backendImage.ref,
        table.name,
        backendLogGroup.name,
        bucket.bucket,
        orchestratorLambda.name,
        asProcessingQueue.url,
        lb.dnsName,
    ]).apply(([imageName, tableName, logGroupName, bucketName, lambdaName, sqsQueueUrl, albDns]) =>
        JSON.stringify([
            {
                name: "backend",
                image: imageName,
                essential: true,
                logConfiguration: {
                    logDriver: "awslogs",
                    options: {
                        "awslogs-group": logGroupName,
                        "awslogs-region": region,
                        "awslogs-stream-prefix": "ecs",
                    },
                },
                portMappings: [
                    { containerPort: 4000, hostPort: 4000, protocol: "tcp" },
                ],
                environment: [
                    { name: "AWS_REGION", value: region },
                    { name: "TABLE_NAME", value: tableName },
                    { name: "PORT", value: "4000" },
                    { name: "BUCKET_NAME", value: bucketName },
                    { name: "ORCHESTRATOR_LAMBDA_NAME", value: lambdaName },
                    { name: "SQS_QUEUE_URL", value: sqsQueueUrl }, 
                    { name: "BACKEND_ALB_DNS", value: albDns },
                ],
            },
        ])
    ),
});

// --- ECS Service for Backend ---
const backendService = new aws.ecs.Service("ecs-backend-service", {
    cluster: appCluster.arn,
    desiredCount: 1,
    launchType: "EC2",
    taskDefinition: backendTaskDefinition.arn,
    deploymentMinimumHealthyPercent: 0,
    deploymentMaximumPercent: 100,
    networkConfiguration: undefined, // bridge mode
    loadBalancers: [{
        targetGroupArn: backendTargetGroup.arn,
        containerName: "backend",
        containerPort: 4000,
    }],
});


// --- .env file generation for backend ---
pulumi
  .all([table.name, bucket.bucket, lb.dnsName, backendApiDomainName])
  .apply(([tableName, bucketName, lbDnsName, apiDomainName]) => {
    const envContent = `
AWS_REGION=${region}
TABLE_NAME=${tableName}
PORT=4000
BUCKET_NAME=${bucketName}
BACKEND_URL=https://${apiDomainName} # Frontend will use this
ALB_DNS_NAME=${lbDnsName} 
AUTH0_AUDIENCE=https://${apiDomainName}
AUTH0_ISSUER_BASE_URL=https://${auth0IssuerBaseUrl}/

`.trim();

    const envFilePath = path.join(__dirname, "../backend/.env");
    fs.writeFileSync(envFilePath, envContent, { encoding: "utf8" });
    console.log(`Wrote .env file to ${envFilePath}`);
    return envContent;
  });

// --- Exports ---
// export const tableName = table.name;
// export const ecrBackendRepoUrl = backendRepo.repositoryUrl;
// export const ecrBackendRepoName = backendRepo.name;
// export const ecrAsRepoUrl = asRepo.repositoryUrl;
// export const ecrAsRepoName = asRepo.name;
// export const bucketName = bucket.bucket;
// export const backendEcsServiceName = backendService.name;
// export const ecsClusterName = appCluster.name; 
// export const backendEcsTaskDefinitionArn = backendTaskDefinition.arn; 
// export const ecspubKeyPath = pubKeyPath;
// export const backendLoadBalancerDnsName = lb.dnsName;
// export const backendApiCustomDomain = backendApiDomainName; 
// export const asOrchestratorLambdaFunctionName = orchestratorLambda.name; 
// export const asProcessingQueueUrl = asProcessingQueue.url;
// export const asEcsServiceName = asService.name; 
// export const aiModelsBucketName = aiModelsBucket.bucket;


lb.dnsName.apply(dns => console.log(`Make sure in Cloudflare, record "apt-t" points to ${dns}`));
// export const backendLoadBalancerDnsName = lb.dnsName;