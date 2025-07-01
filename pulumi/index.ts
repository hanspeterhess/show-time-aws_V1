import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";

// S3 bucket
const bucket = new aws.s3.Bucket("timeBucket", {
    // acl: "public-read", // optional for public read
    website: {
        indexDocument: "index.html"
    }
});

// IAM Role for EC2 to access S3
const role = new aws.iam.Role("ec2Role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
});

new aws.iam.RolePolicyAttachment("s3FullAccess", {
    role: role.name,
    policyArn: aws.iam.ManagedPolicy.AmazonS3FullAccess,
});

const profile = new aws.iam.InstanceProfile("ec2Profile", {
    role: role.name,
});

// Security Group for EC2
const sg = new aws.ec2.SecurityGroup("webSg", {
    description: "Allow HTTP on port 3000",
    ingress: [{
        protocol: "tcp",
        fromPort: 3000,
        toPort: 3000,
        cidrBlocks: ["0.0.0.0/0"],
    }],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
    }],
});

// Get latest Ubuntu AMI
const ami = aws.ec2.getAmi({
    filters: [
        { name: "name", values: ["ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-*"] },
        { name: "virtualization-type", values: ["hvm"] },
    ],
    owners: ["099720109477"],
    mostRecent: true,
});

// Read EC2 startup script
const userData = fs.readFileSync("backend-user-data.sh", "utf-8");

// EC2 instance
const server = new aws.ec2.Instance("backendServer", {
    instanceType: "t3.micro",
    ami: ami.then(a => a.id),
    userData: pulumi.interpolate`#!/bin/bash
echo "S3_BUCKET=${bucket.bucket}" >> /etc/environment
${userData}`,
    vpcSecurityGroupIds: [sg.id],
    iamInstanceProfile: profile.name,
    tags: { Name: "BackendServer" },
});

// Export outputs
export const bucketName = bucket.bucket;
export const ec2PublicIp = server.publicIp;
export const apiUrl = pulumi.interpolate`http://${server.publicIp}:3000/save-time`;
export const s3JsonUrl = pulumi.interpolate`https://${bucket.bucket}.s3.amazonaws.com/time.json`;
