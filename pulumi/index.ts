import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { NatGateway } from "@pulumi/aws/ec2";
import * as fs from "fs";
import * as path from "path";
import { log } from "console";


// Config
const config = new pulumi.Config();
const region = aws.config.region || "eu-central-1";

// Get the image tag from config or default to "latest"
const imageTag = config.get("imageTag") || "latest";

// Create a Key Pair in AWS
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

// ECR Repository
const repo = new aws.ecr.Repository("show-time-backend", {
    forceDelete: true,
    tags: {
        Project: "TimeStoreApp",
    },
});

// 1. Create a VPC (default)
// const vpc = new awsx.ec2.Vpc("ecs-vpc", {});
// Alternatively, only create one public subnet
const vpc = new awsx.ec2.Vpc("ecs-vpc", {
    numberOfAvailabilityZones: 1,
    subnetStrategy: awsx.ec2.SubnetAllocationStrategy.Legacy,
    subnetSpecs: [{ 
        type: awsx.ec2.SubnetType.Public, 
        name: "public-subnet" 
    }],
    natGateways: { strategy: awsx.ec2.NatGatewayStrategy.None }, // Disable NAT Gateway for simplicity
});

// 2. Create an ECS Cluster
const cluster = new aws.ecs.Cluster("ecs-cluster", {
    name: "show-time-cluster",
});

// 3. IAM Role for ECS task
const taskExecRole = new aws.iam.Role("ecsTaskExecRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ecs-tasks.amazonaws.com" }),
});

// Attach policies to the ECS task execution role
new aws.iam.RolePolicyAttachment("ecsTaskExecPolicy", {
    role: taskExecRole.name,
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
  role: taskExecRole.id,
  policy: dynamoPolicy.apply(p => JSON.stringify(p)),
});

// 4. Create a Security Group for the ECS service
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

const logGroup = new aws.cloudwatch.LogGroup("ecs-log-group");

// 5. Create an ECS Task Definition
const taskDefinition = new aws.ecs.TaskDefinition("ecs-task", {
    family: "show-time-task",
    networkMode: "bridge",
    cpu: "256",
    memory: "512",
    requiresCompatibilities: ["EC2"],
    executionRoleArn: taskExecRole.arn,   // For ECS service tasks (pull images, logs)
    taskRoleArn: taskExecRole.arn,        // For your app permissions (like DynamoDB access)
    containerDefinitions: pulumi.all([
        repo.repositoryUrl, 
        table.name,
        logGroup.name,
    ]).apply(([imageUrl, tableName, logGroupName]) =>
        JSON.stringify([
            {
                name: "show-time-backend",
                image: `${imageUrl}:${imageTag}`,
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
                ],
            },
        ])
    ),
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

new aws.iam.RolePolicy("ecsS3Policy", {
    role: taskExecRole.name,
    policy: s3Policy.apply(p => JSON.stringify(p)),
});

// 7. ECS Service
const service = new aws.ecs.Service("ecs-service", {
    cluster: cluster.arn,
    desiredCount: 1,
    launchType: "EC2",
    taskDefinition: taskDefinition.arn,
    deploymentMinimumHealthyPercent: 0,
    deploymentMaximumPercent: 100,
    networkConfiguration: undefined, // bridge mode
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

// ECS optimized AMI
const ami = aws.ec2.getAmi({
    filters: [
        { name: "name", values: ["amzn2-ami-ecs-hvm-*-x86_64-ebs"] },
        { name: "owner-alias", values: ["amazon"] },
    ],
    mostRecent: true,
});

const userData = cluster.name.apply(clusterName =>
    Buffer.from(`#!/bin/bash
echo ECS_CLUSTER=${clusterName} >> /etc/ecs/ecs.config
`).toString("base64")
);

const launchTemplate = new aws.ec2.LaunchTemplate("ecs-launch-template", {
    imageId: ami.then(a => a.id),
    instanceType: "t3.micro",
    keyName: keyPair.keyName,
    iamInstanceProfile: {
        name: instanceProfile.name,
    },
    vpcSecurityGroupIds: [sg.id],
    userData,
    tagSpecifications: [{
        resourceType: "instance",
        tags: {
            Name: "ecs-instance",
        },
    }],
});

const autoScalingGroup = new aws.autoscaling.Group("ecs-asg", {
    vpcZoneIdentifiers: vpc.publicSubnetIds,
    minSize: 1,
    maxSize: 1,
    desiredCapacity: 1,
        launchTemplate: {
        id: launchTemplate.id,
        version: "$Latest",
    },
    tags: [
        {
            key: "Name",
            value: "ecs-instance",
            propagateAtLaunch: true,
        },
    ],
});

export const tableName = table.name;
export const ecrRepoUrl = repo.repositoryUrl;
export const ecrRepoName = repo.name;

export const bucketName = bucket.bucket;

export const ecsServiceName = service.name;
export const ecsClusterName = cluster.name;
export const ecsTaskDefinitionArn = taskDefinition.arn;

export const ecspubKeyPath = pubKeyPath;
