#!/bin/bash

# Add System Manager agent
sudo apt-get update,
sudo apt-get install -y amazon-ssm-agent
sudo systemctl enable amazon-ssm-agent
sudo systemctl start amazon-ssm-agent

# Add MongoDB repository
echo "[mongodb-org-6.0]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/amazon/2/mongodb-org/6.0/x86_64/
gpgcheck=1
enabled=1
gpgkey=https://pgp.mongodb.com/server-6.0.asc" | sudo tee /etc/yum.repos.d/mongodb-org-6.0.repo

# Update and install MongoDB, AWS CLI, and jq
sudo yum update -y
sudo yum install -y mongodb-org aws-cli jq

# Start MongoDB
sudo service mongod start
sudo chkconfig mongod on

# Wait for MongoDB to start up
sleep 20

# Set AWS Region for AWS CLI from instance metadata
export AWS_DEFAULT_REGION=`curl --silent http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .region`
echo "This instance is provisioned in region: $AWS_DEFAULT_REGION"

# Retrieve MongoDB credentials from AWS Secrets Manager
MONGO_CREDENTIALS=$(aws secretsmanager get-secret-value --secret-id mongodb/credentials --query SecretString --output text)
MONGO_USERNAME=$(echo $MONGO_CREDENTIALS | jq -r .username)
MONGO_PASSWORD=$(echo $MONGO_CREDENTIALS | jq -r .password)
echo "User: $MONGO_USERNAME"
echo "Pass: $MONGO_PASSWORD"

# User setup
mongosh <<EOF
use admin
db.createUser({ user: '$MONGO_USERNAME', pwd: '$MONGO_PASSWORD', roles: [{ role: "userAdminAnyDatabase", db: "admin" }, { role: "readWriteAnyDatabase", db: "admin" }, { role: "backup", db: "admin" }]})
EOF

sudo wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq
sudo chmod +x /usr/bin/yq
sudo yq e '.security.authorization = "enabled"' -i /etc/mongod.conf
sudo yq e '.net.bindIp = "0.0.0.0"' -i /etc/mongod.conf

sudo service mongod restart