# AWS EKS Web Application with MongoDB on EC2

## Overview

This repository provisions an AWS environment using CDK (TypeScript) and deploys the application from [@jeffthorne/tasky](https://github.com/jeffthorne/tasky) (on EKS) which uses MongoDB running on EC2.

**WARNING:** This setup is intentionally insecure for demonstration purposes (public S3, public SSH). Do not use in production!

## Structure

- `infra/` — AWS CDK project (TypeScript)
- `application/` — Application code from [@jeffthorne/tasky](https://github.com/jeffthorne/tasky)

## Application Directory

The `application` directory contains the code from [@jeffthorne/tasky](https://github.com/jeffthorne/tasky).  

## Quickstart

```bash
# Provision infrastructure
cd infra
npm install
cdk bootstrap
cdk deploy 

# Build & Deploy application
cd application
# Follow instructions in the tasky README to build and containerize the app

See each subdirectory’s README for details.