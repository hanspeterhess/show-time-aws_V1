import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as docker from "@pulumi/docker";

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

export const tableName = table.name;
export const ecrRepoUrl = repo.repositoryUrl;
export const dockerImageUrl = image.imageName;
