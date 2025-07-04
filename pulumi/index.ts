import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as fs from "fs";

// Config
const config = new pulumi.Config();
const region = aws.config.region || "eu-central-1";

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
    executionRoleArn: taskExecRole.arn,
    containerDefinitions: pulumi.all([repo.repositoryUrl]).apply(([imageUrl]) =>
        JSON.stringify([
            {
                name: "show-time-backend",
                image: `${imageUrl}:latest`,
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
                    { name: "TABLE_NAME", value: table.name },
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

// Export the JSON definition
taskDefinition.arn.apply(async (arn) => {
  const def = await aws.ecs.getTaskDefinition({ taskDefinition: arn });
  fs.writeFileSync("./ecs-task-def.json", JSON.stringify(def.containerDefinitions));
});


export const tableName = table.name;
export const ecrRepoUrl = repo.repositoryUrl;
export const ecrRepoName = repo.name;

export const ecsServiceName = service.name;
export const ecsClusterName = cluster.name;
export const ecsTaskDefinitionArn = taskDefinition.arn;
