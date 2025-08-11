# Product Requirements Document (PRD)

## Project Overview

This project aims to create a new repository that provides both infrastructure as code (IaC) and application code to deploy a secure, cloud-native web application on AWS. The solution leverages AWS CDK (in TypeScript) for IaC, with a Kubernetes-based application stack running on EKS, integrated with a MongoDB database hosted on an EC2 instance. The repository will be structured into two main directories: one for IaC and one for application code.

---

## Goals

- **Automate** the provisioning of all required AWS infrastructure for a secure and scalable web application.
- **Provide** a ready-to-run containerized web application with integrated MongoDB persistence.
- **Enforce** specific security, compliance, and operational requirements as detailed below.
- **Enable** easy deployment and reproducibility via code.

---

## Repository Structure

- `/infrastructure` - AWS CDK project (TypeScript) for provisioning all AWS resources.
- `/application` - Source code for the containerized web application.

---

## Detailed Requirements

### 1. Infrastructure as Code (CDK, TypeScript)

- **AWS Resources to Provision:**
  - **VPC** with at least two subnets:
    - One **public subnet**
    - One **private subnet**
  - **EKS Cluster** deployed into the private subnet.
  - **EC2 Instance** (for MongoDB) deployed in the public subnet.
    - Must use a Linux AMI/version that is at least 1 year old.
    - Must allow public SSH access (open port 22 to the internet).
    - Must have an IAM Role that permits creation of additional EC2 instances.
    - Must have MongoDB installed with a version that is at least 1 year old.
    - Use EC2 User Data within a Launch Configuration
    - MongoDB must require authentication.
    - MongoDB network access must be restricted so only the EKS cluster can connect (except for SSH).
    - Must have daily automated backups of the MongoDB data to an S3 bucket.
  - **S3 Bucket** for MongoDB backups:
    - Must allow public read and public listing of contents.
  - **Application Load Balancer (ALB)**:
    - Must be publicly accessible.
    - Must route external traffic to the containerized web application running in EKS.
  - **Kubernetes Ingress** for the application.

### 2. Application Code

- **Web Application:**
  - Must be containerized (Docker).
  - The container image must include a file called `wizexercise.txt` containing the string: `Vito De Giosa`.
  - Application must read the MongoDB connection string from an environment variable (configured in Kubernetes).
  - Must connect to the MongoDB instance using authentication.
  - Must be assigned cluster-wide Kubernetes admin role and privileges.
  - Must be exposed via a Kubernetes ingress (which is routed through the AWS ALB).

---

## Security & Compliance Requirements

- **EC2/MongoDB**
  - Linux image and MongoDB version must be at least 1 year old (no newer).
  - Public SSH access is required for the EC2 instance.
  - EC2 IAM Role must allow creation of other EC2 instances.
  - Only the EKS cluster should be able to access MongoDB (except for SSH).
- **Backups**
  - MongoDB backups must be performed daily to an S3 bucket.
  - S3 bucket must allow public read and listing (note: this is insecure but required for the exercise).

---

## Operational Requirements

- **All infrastructure** should be defined using AWS CDK (TypeScript) and support `cdk deploy` for reproducible deployments.
- **All application deployment** should be automated (Helm chart, manifest, or similar).
- **README** with instructions for:
  - Initial setup and prerequisites.
  - Deployment of both infrastructure and application.
  - Accessing the application and MongoDB (for validation).
  - Noting all security caveats (public S3, public SSH, etc).

---

## Deliverables

1. `/infrastructure` directory:
   - AWS CDK app in TypeScript.
   - Scripts for automated backups.
   - CDK constructs for VPC, subnets, EC2, EKS, IAM, S3, ALB, security groups, etc.

2. `/application` directory:
   - Containerized web application (Dockerfile).
   - `wizexercise.txt` with required string.
   - Example Kubernetes manifests/Helm chart for deployment.
   - Instructions for setting up environment variables and RBAC.

3. **Documentation** as described above.

---

## Non-Goals

- Application feature set beyond simple MongoDB connectivity and test endpoint.
- Production-grade security (some requirements are intentionally insecure for this exercise).
- Multi-region or multi-cloud support.

---

## Open Questions

- What stack should be used for the web application (Node.js, Python, etc)? (Default to Node.js if unspecified.)
- What should the application do beyond demonstrating MongoDB connectivity and returning a simple response?
- Who will own and maintain the repository after initial delivery?

---

## Appendix

- **Compliance risks:** This architecture exposes several insecure configurations (public S3, public SSH) and is **not** recommended for production use.