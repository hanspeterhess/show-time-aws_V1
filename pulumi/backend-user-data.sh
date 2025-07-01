#!/bin/bash

# Update system
apt-get update -y

# Install necessary packages
apt-get install -y curl unzip git

# Install Node.js (v18)
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# Install PM2 to run app persistently
npm install -g pm2

# Install SSM Agent
curl "https://s3.eu-central-1.amazonaws.com/amazon-ssm-eu-central-1/latest/debian_amd64/amazon-ssm-agent.deb" -o amazon-ssm-agent.deb
dpkg -i amazon-ssm-agent.deb
systemctl enable amazon-ssm-agent
systemctl start amazon-ssm-agent

# Clone your backend repo and start app as ubuntu user
sudo -u ubuntu bash <<'EOF'
cd /home/ubuntu
git clone https://github.com/hanspeterhess/show-time-aws_V1.git
cd show-time-aws_V1/backend
npm install

# Start the app with pm2, passing S3_BUCKET env explicitly
pm2 start npm --name backend -- run start --env S3_BUCKET=$S3_BUCKET

pm2 save
EOF

