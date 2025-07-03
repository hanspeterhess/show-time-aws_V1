import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const table = new aws.dynamodb.Table("timeStampsTable", {
    attributes: [
        {
            name: "id",
            type: "S",  // String type partition key
        },
    ],
    hashKey: "id",
    billingMode: "PAY_PER_REQUEST", // on-demand mode, no capacity to manage
    tags: {
        Environment: "dev",
        Project: "TimeStoreApp",
    },
});

export const tableName = table.name;
