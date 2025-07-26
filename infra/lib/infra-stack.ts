import * as cdk from 'aws-cdk-lib';
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with public and private subnets
    const vpc = new Vpc(this, 'AppVpc', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: SubnetType.PUBLIC
        },
        {
          name: 'private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS
        }
      ]
    });
  }
}
