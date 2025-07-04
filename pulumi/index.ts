import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";


// Config
const config = new pulumi.Config();
const region = aws.config.region || "eu-central-1";

// Get the image tag from config or default to "latest"
const imageTag = config.get("imageTag") || "latest";

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
// const vpc = new awsx.ec2.Vpc("ecs-vpc", {
//     subnets: [{ type: "public" }],
// });
const vpc = new awsx.ec2.Vpc("ecs-vpc", {});

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
    description: "Allow HTTP",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 4000,
            toPort: 4000,
            cidrBlocks: ["0.0.0.0/0"],
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

// 5. Create an ECS Task Definition
const taskDefinition = new aws.ecs.TaskDefinition("ecs-task", {
    family: "show-time-task",
    networkMode: "bridge",
    cpu: "256",
    memory: "512",
    requiresCompatibilities: ["EC2"],
    executionRoleArn: taskExecRole.arn,   // For ECS service tasks (pull images, logs)
    taskRoleArn: taskExecRole.arn,        // For your app permissions (like DynamoDB access)
    containerDefinitions: pulumi.all([repo.repositoryUrl, table.name]).apply(([imageUrl, tableName]) =>
        JSON.stringify([
            {
                name: "show-time-backend",
                image: `${imageUrl}:${imageTag}`,
                essential: true,
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

export const ecsServiceName = service.name;
export const ecsClusterName = cluster.name;
export const ecsTaskDefinitionArn = taskDefinition.arn;
