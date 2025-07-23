import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as fs from "fs";
import * as path from "path";
import * as docker from "@pulumi/docker";


// Config
const config = new pulumi.Config();
const region = aws.config.region || "eu-central-1";

// This is the subdomain for backend API (e.g., 'api.aikeso.com')
const backendApiDomainName = config.require("backendApiDomainName");


// Get the image tag for backend and analysis server as from config or default to "latest"
const backendImageTag = config.get("backendImageTag") || "b_latest";
const asImageTag = config.get("asImageTag") || "as_latest";

// Add existing key pair to AWS
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
    attributes: [
        {
            name: "id",
            type: "S",
        },
    ],
    hashKey: "id",
    billingMode: "PAY_PER_REQUEST",
    tags: {
        Environment: "dev",
        Project: "TimeStoreApp",
    },
});

// ECR Repository for backend
const backendRepo = new aws.ecr.Repository("backend-repo", {
    forceDelete: true,
    tags: {
        Project: "orthelot",
    },
});

// ECR Repository for analysis server (as)
const asRepo = new aws.ecr.Repository("analysis-server-repo", {
    forceDelete: true,
    tags: {
        Project: "orthelot",
    },
});

const backendImage = new docker.Image("backend-image", {
    imageName: pulumi.interpolate`${backendRepo.repositoryUrl}:${backendImageTag}`,
    build: {
        context: "../backend",
        dockerfile: "../backend/Dockerfile.backend",
        platform: "linux/amd64",
    },
    registry: backendRepo.repositoryUrl.apply(repoUrl => {
        const server = repoUrl.split("/")[0];
        return aws.ecr.getCredentialsOutput({ registryId: backendRepo.registryId }).apply(creds => {
            const decodedCreds = Buffer.from(creds.authorizationToken, "base64").toString();
            const [username, password] = decodedCreds.split(":");
            return {
                server,
                username,
                password,
            };
        });
    }),
});

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
            return {
                server,
                username,
                password,
            };
        });
    }),
});

// Create a VPC, and only create one public subnet
const vpc = new awsx.ec2.Vpc("ecs-vpc", {
    numberOfAvailabilityZones: 2,
    subnetStrategy: awsx.ec2.SubnetAllocationStrategy.Legacy,
    subnetSpecs: [{ 
        type: awsx.ec2.SubnetType.Public, 
        name: "public-subnet" 
    }],
    natGateways: { strategy: awsx.ec2.NatGatewayStrategy.None }, // Disable NAT Gateway for simplicity
});

// Create an ECS Cluster for backend
const appCluster = new aws.ecs.Cluster("app-cluster", {
    name: "app-cluster",
});

// IAM Role for backend ECS task
const backendTaskExecRole = new aws.iam.Role("backendEcsTaskExecRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ecs-tasks.amazonaws.com" }),
});

// Attach policies to the backend ECS task execution role
new aws.iam.RolePolicyAttachment("backendEcsTaskExecPolicy", {
    role: backendTaskExecRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
});

// IAM Role for analysis server ECS task
const asTaskExecRole = new aws.iam.Role("asEcsTaskExecRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ecs-tasks.amazonaws.com" }),
});

// Attach policies to the analysis server ECS task execution role
new aws.iam.RolePolicyAttachment("asEcsTaskExecPolicy", {
    role: asTaskExecRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
});

const dynamoPolicy = table.arn.apply(arn => ({
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
}));

new aws.iam.RolePolicy("ecsDynamoDBAccessPolicy", {
  role: backendTaskExecRole.id,
  policy: dynamoPolicy.apply(p => JSON.stringify(p)),
});

// S3 Bucket
const bucket = new aws.s3.Bucket("uploadBucket", {
    forceDestroy: true, // deletes even non-empty buckets
    corsRules: [{
        allowedMethods: ["GET", "PUT"],
        allowedOrigins: ["*"], // restrict in prod
        allowedHeaders: ["*"],
    }],
    tags: { Project: "TimeStoreApp" },
});

const s3Policy = bucket.arn.apply(arn => ({
    Version: "2012-10-17",
    Statement: [
        {
            Effect: "Allow",
            Action: ["s3:PutObject", "s3:GetObject"],
            Resource: `${arn}/*`,
        },
    ],
}));

const bucketCors = new aws.s3.BucketCorsConfigurationV2("upload-bucket-cors", {
    bucket: bucket.id,
    corsRules: [{
        allowedHeaders: ["*"], // Allow all headers
        allowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"], // Methods allowed from your frontend
        allowedOrigins: [
            "https://dev-t.aikeso.com",
            "http://localhost:3000" // If you test locally
        ],
        exposeHeaders: [],
        maxAgeSeconds: 3000,
    }],
});

// IAM Policy for S3 read access
const s3ReadPolicy = new aws.iam.Policy("s3-read-policy-as", {
    description: "Allows AS to read objects from the upload S3 bucket",
    policy: pulumi.all([bucket.arn]).apply(([bucketArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "s3:GetObject",
                ],
                Resource: [
                    `${bucketArn}/*`, // Allows access to all objects within the bucket
                ],
            },
        ],
    })),
});

new aws.iam.PolicyAttachment("as-s3-read-policy-attachment", {
    roles: [asTaskExecRole], // Attach to your existing AS task role
    policyArn: s3ReadPolicy.arn,
});

new aws.iam.RolePolicy("ecsS3Policy", {
    role: backendTaskExecRole.name,
    policy: s3Policy.apply(p => JSON.stringify(p)),
});

// Create a Security Group for the ECS services
const sg = new aws.ec2.SecurityGroup("ecs-sg", {
    vpcId: vpc.vpc.id,
    description: "Allow HTTP and SSH access",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 4000,
            toPort: 4000,
            cidrBlocks: ["0.0.0.0/0"],
        },
        {
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrBlocks: ["0.0.0.0/0"], // Allow SSH from anywhere (OK for dev)
        },
    ],
    egress: [
        {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
});

const backendLogGroup = new aws.cloudwatch.LogGroup("ecs-backend-log-group");
const asLogGroup = new aws.cloudwatch.LogGroup("ecs-as-log-group");

// Create an ECS Task Definition for backend
const backendTaskDefinition = new aws.ecs.TaskDefinition("ecs-backend-task", {
    family: "backend-task",
    networkMode: "bridge",
    cpu: "256",
    memory: "512",
    requiresCompatibilities: ["EC2"],
    executionRoleArn: backendTaskExecRole.arn,   // For ECS service tasks (pull images, logs)
    taskRoleArn: backendTaskExecRole.arn,        // For your app permissions (like DynamoDB access)
    containerDefinitions: pulumi.all([
        backendImage.imageName, 
        table.name,
        backendLogGroup.name,
        bucket.bucket,
        asRepo.repositoryUrl,
    ]).apply(([imageName, tableName, logGroupName, bucketName, asUrl]) =>
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
                    {
                        containerPort: 4000,
                        hostPort: 4000,
                        protocol: "tcp",
                    },
                ],
                environment: [
                    { name: "AWS_REGION", value: region },
                    { name: "TABLE_NAME", value: tableName },
                    { name: "PORT", value: "4000" },
                    { name: "BUCKET_NAME", value: bucketName },
                ],
            },
        ])
    ),
});

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
const ami = aws.ec2.getAmi({
    filters: [
        { name: "name", values: ["amzn2-ami-ecs-hvm-*-x86_64-ebs"] },
        { name: "owner-alias", values: ["amazon"] },
    ],
    mostRecent: true,
});

const backendUserData = appCluster.name.apply(clusterName =>
    Buffer.from(`#!/bin/bash
echo ECS_CLUSTER=${clusterName} >> /etc/ecs/ecs.config
`).toString("base64")
);

const asUserData = appCluster.name.apply(clusterName =>
    Buffer.from(`#!/bin/bash
echo ECS_CLUSTER=${clusterName} >> /etc/ecs/ecs.config
`).toString("base64")
);

const backendLaunchTemplate = new aws.ec2.LaunchTemplate("ecs-backend-launch-template", {
    imageId: ami.then(a => a.id),
    instanceType: "t3.micro",
    keyName: keyPair.keyName,
    iamInstanceProfile: {
        name: instanceProfile.name,
    },
    vpcSecurityGroupIds: [sg.id],
    userData: backendUserData,
    tagSpecifications: [{
        resourceType: "instance",
        tags: {
            Name: "ecs-backend-instance",
        },
    }],
});


const asLaunchTemplate = new aws.ec2.LaunchTemplate("ecs-as-launch-template", {
    imageId: ami.then(a => a.id),
    instanceType: "t3.micro",
    keyName: keyPair.keyName,
    iamInstanceProfile: {
        name: instanceProfile.name,
    },
    vpcSecurityGroupIds: [sg.id],
    userData: asUserData,
    tagSpecifications: [{
        resourceType: "instance",
        tags: {
            Name: "ecs-as-instance",
        },
    }],
});

// Auto Scaling Group for backend
const backendAutoScalingGroup = new aws.autoscaling.Group("ecs-backend-asg", {
    vpcZoneIdentifiers: vpc.publicSubnetIds,
    minSize: 1,
    maxSize: 1,
    desiredCapacity: 1,
    launchTemplate: {
        id: backendLaunchTemplate.id,
        version: "$Latest",
    },
    tags: [
        {
            key: "Name",
            value: "ecs-backend-instance",
            propagateAtLaunch: true,
        },
    ],
});

// Create a Load Balancer Security Group
const lbSg = new aws.ec2.SecurityGroup("lb-sg", {
    vpcId: vpc.vpc.id,
    description: "Allow HTTP and HTTPS access to Load Balancer",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 4000,
            toPort: 4000,
            cidrBlocks: ["0.0.0.0/0"],
        },
        {
            protocol: "tcp",
            fromPort: 443, // Add HTTPS port
            toPort: 443,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});


// Create the Load Balancer
const lb = new aws.lb.LoadBalancer("socket-io-lb", {
    internal: false,
    securityGroups: [lbSg.id],
    subnets: vpc.publicSubnetIds,
    loadBalancerType: "application", // Use Application Load Balancer for HTTP/HTTPS
});

// Create a Target Group for the backend instances
const backendTargetGroup = new aws.lb.TargetGroup("backend-tg", {
    port: 4000, // Port on the backend instances
    protocol: "HTTP", // Or HTTPS if your backend serves over HTTPS
    targetType: "instance",
    vpcId: vpc.vpc.id,
    healthCheck: {
        path: "/health", // Or your Socket.IO health check endpoint
        protocol: "HTTP",
        matcher: "200",
        interval: 30,
        timeout: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
    },
    // Enable sticky sessions for Socket.IO
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


// Create a Listener for the Load Balancer on HTTPS (port 443)
const lbListenerHttps = new aws.lb.Listener("backend-listener-https", {
    loadBalancerArn: lb.arn,
    port: 443, // Standard HTTPS port
    protocol: "HTTPS",
    sslPolicy: "ELBSecurityPolicy-2016-08", // Recommended SSL policy
    certificateArn: certificate.arn, // Use the ACM certificate
    defaultActions: [{
        type: "forward",
        targetGroupArn: backendTargetGroup.arn,
    }],
});

const lbListenerHttpRedirect = new aws.lb.Listener("backend-listener-http-redirect", {
    loadBalancerArn: lb.arn,
    port: 4000, // Your current HTTP port
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
// ECS Service for backend
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
        containerName: "backend", // Name of the container in your Task Definition
        containerPort: 4000, // Port the container exposes
    }],
});

// Create an ECS Task Definition for analysis server (as)
const asTaskDefinition = new aws.ecs.TaskDefinition("ecs-as-task", {
    family: "as-task",
    networkMode: "bridge",
    cpu: "256",
    memory: "512",
    requiresCompatibilities: ["EC2"],
    executionRoleArn: asTaskExecRole.arn,
    taskRoleArn: asTaskExecRole.arn,
    containerDefinitions: pulumi.all([
        asImage.imageName,
        asLogGroup.name,
        backendApiDomainName,
    ]).apply(([imageName, logGroupName, apiDomain]) =>
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
                    { name: "AWS_REGION", value: region },
                    { name: "BACKEND_SERVER_URL", value: `https://${apiDomain}` },
                ],
            },
        ])
    ),
    placementConstraints: [{
        type: "memberOf",
        expression: "attribute:ecs.instance-type == t3.micro" // For now, constrain to t3.micro. This will change to GPU instance type later.
        // TODO: When you move to GPU, you'll change this to:
        // expression: "attribute:ecs.instance-type =~ g4dn" // or your specific GPU instance type
        // Or if you use custom attributes on your ASG's launch template instance tags:
        // expression: "attribute:ecs.instance-attribute.gpu == true"
    }],
});

// ECS Service for analysis server (as)
const asService = new aws.ecs.Service("ecs-as-service", {
    cluster: appCluster.arn,
    desiredCount: 1,
    launchType: "EC2",
    taskDefinition: asTaskDefinition.arn,
    deploymentMinimumHealthyPercent: 0,
    deploymentMaximumPercent: 100,
    networkConfiguration: undefined, // bridge mode
});


// Auto Scaling Group for analysis server (as)
const asAutoScalingGroup = new aws.autoscaling.Group("ecs-as-asg", {
    vpcZoneIdentifiers: vpc.publicSubnetIds,
    minSize: 1, //will be changed to 0 later for on-demand scaling
    maxSize: 1,
    desiredCapacity: 1,
    launchTemplate: {
        id: asLaunchTemplate.id,
        version: "$Latest",
    },
    tags: [
        {
            key: "Name",
            value: "ecs-as-instance",
            propagateAtLaunch: true,
        },
    ],
});


pulumi
  .all([table.name, bucket.bucket, lb.dnsName, backendApiDomainName])
  .apply(([tableName, bucketName, lbDnsName, apiDomainName]) => {
    const envContent = `
AWS_REGION=${region}
TABLE_NAME=${tableName}
PORT=4000
BUCKET_NAME=${bucketName}
BACKEND_URL=https://${apiDomainName} # Frontend will use this
ALB_DNS_NAME=${lbDnsName} #
`.trim();

    // Define the path to the .env file inside your backend folder
    const envFilePath = path.join(__dirname, "../backend/.env");

    // Write the file synchronously (during Pulumi deployment)
    fs.writeFileSync(envFilePath, envContent, { encoding: "utf8" });

    console.log(`Wrote .env file to ${envFilePath}`);

    return envContent;
  });

export const tableName = table.name;
export const ecrRepoUrl = backendRepo.repositoryUrl;
export const ecrRepoName = backendRepo.name;

export const bucketName = bucket.bucket;

export const ecsServiceName = backendService.name;
export const ecsClusterName = appCluster.name;

export const backendInstancePublicIp = backendRepo.repositoryUrl


export const ecsTaskDefinitionArn = backendTaskDefinition.arn;

export const ecspubKeyPath = pubKeyPath;

export const backendLoadBalancerDnsName = lb.dnsName; // Export ALB DNS name for CNAME
export const backendApiDomain = backendApiDomainName; // Export the custom domain for reference

