#!/bin/sh
# entrypoint.sh

# Exit immediately if a command exits with a non-zero status.
set -e

echo "Starting entrypoint.sh for Tasky application..."

# Check if required environment variables are set
# These variables will be passed from Kubernetes Deployment
if [ -z "$MONGODB_USERNAME" ] || [ -z "$MONGODB_PASSWORD" ] || [ -z "$MONGODB_HOST" ]; then
  echo "Error: One or more required MongoDB environment variables (username, password, MONGODB_HOST) are not set."
  exit 1
fi

# Construct the MONGODB_URI
MONGODB_URI="mongodb://${MONGODB_USERNAME}:${MONGODB_PASSWORD}@${MONGODB_HOST}"

echo "Constructed MONGODB_URI (masked for security): mongodb://<username>:****@${MONGODB_HOST}"

# Export the constructed URI so it's available to your Go application
export MONGODB_URI

# Execute main Go application
echo "Launching /app/tasky..."
exec /app/tasky "$@" # "$@" passes any arguments given to the container to your Go app