import * as cdk from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType, MachineImage, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { MongoDbInstanceWithBackup } from './mongodb-instance';

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

    const mongoDBInstance = new MongoDbInstanceWithBackup(this, "MongoDBInstanceWithBackup", {
      vpc,
      vpcSubnet: vpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnets[0],
      machineImage: MachineImage.genericLinux({
        'us-east-1': 'ami-0195204d5dce06d99' // <- amzn2-ami-kernel-5.10-hvm-2.0.20240620.0-x86_64-gp2
      }),
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.SMALL),
      backupConfig: {
        scheduleExpression: 'cron(0 2 * * ? *)'
      }
    });

    // Output the EC2 instance public IP for easy access
    new cdk.CfnOutput(this, 'MongoDBInstancePrivateIp', {
      value: mongoDBInstance.instance.instancePrivateIp,
      description: 'Private IP address of the MongoDB EC2 instance',
    });

    // Output the S3 bucket name if backups are enabled
    if (mongoDBInstance.backupBucket) {
      new cdk.CfnOutput(this, 'BackupS3BucketName', {
        value: mongoDBInstance.backupBucket.bucketName,
        description: 'Name of the S3 bucket for MongoDB backups',
      });
    }
  }
}
