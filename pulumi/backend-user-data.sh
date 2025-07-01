#!/bin/bash

# Update system and install dependencies (your existing setup)
apt-get update -y
apt-get install -y curl unzip git

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2

# Install SSM Agent
curl "https://s3.eu-central-1.amazonaws.com/amazon-ssm-eu-central-1/latest/debian_amd64/amazon-ssm-agent.deb" -o amazon-ssm-agent.deb
dpkg -i amazon-ssm-agent.deb
systemctl enable amazon-ssm-agent
systemctl start amazon-ssm-agent


# Write backend startup script
cat <<'SCRIPT' > /home/ubuntu/start-backend.sh
#!/bin/bash

cd /home/ubuntu
# Clone repo if not already cloned
if [ ! -d "show-time-aws_V1" ]; then
  git clone https://github.com/hanspeterhess/show-time-aws_V1.git
fi

cd show-time-aws_V1/backend

npm install

# Export S3_BUCKET environment variable if set
if [ ! -z "$S3_BUCKET" ]; then
  export S3_BUCKET=$S3_BUCKET
fi

# Start backend app using pm2
pm2 start npm --name backend -- run start

pm2 save
SCRIPT

# Change ownership and permissions so ubuntu user can execute
chown ubuntu:ubuntu /home/ubuntu/start-backend.sh
chmod +x /home/ubuntu/start-backend.sh

# Run backend startup script as ubuntu user
sudo -u ubuntu /home/ubuntu/start-backend.sh