import * as cdk from 'aws-cdk-lib';
import { IMachineImage, ISubnet, IVpc, Instance, InstanceType, Peer, Port, SecurityGroup, UserData } from 'aws-cdk-lib/aws-ec2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Bucket, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { AnyPrincipal, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnDocument } from 'aws-cdk-lib/aws-ssm';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';

/**
 * Props for the MongoDbInstanceWithBackup Construct.
 */
export interface MongoDbInstanceWithBackupProps extends cdk.StackProps {
  /**
   * The VPC where the EC2 instance will be deployed.
   */
  readonly vpc: IVpc;
  /**
   * The Subnet where the EC2 instance will be deployed.
   */
  readonly vpcSubnet: ISubnet;
  /**
   * The EC2 instance type (e.g., ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.Micro)).
   */
  readonly instanceType: InstanceType;
  /**
   * The AMI to use for the EC2 instance (e.g., ec2.MachineImage.latestAmazonLinux2()).
   * Ensure it's a Linux AMI compatible with MongoDB installation.
   */
  readonly machineImage: IMachineImage;
  /**
   * (Optional) Backup configuration.
   */
  readonly backupConfig?: MongoDbInstanceBackupProps;
  /**
   * (Required if enableBackups is true) The name of the AWS Secrets Manager secret storing MongoDB credentials.
   * The SSM document assumes a secret named 'mongodb/credentials' with 'username' and 'password' keys.
   * Example: 'mongodb/credentials'
   */
  readonly mongoDbSecretName?: string;
}

export interface MongoDbInstanceBackupProps {
  /**
   * Cron expression to schedule expression for backups (e.g., 'cron(0 0 * * ? *)' for daily at midnight UTC).
   * See https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-expressions.html
   */
  readonly scheduleExpression: string;
  /**
   * (Optional) Timezone for the schedule. If not available UTC is used.
   */
  readonly scheduleTimezone?: string;
}

/**
 * A CDK Construct that provisions an EC2 instance with MongoDB installed,
 * and optionally sets up daily backups to S3 using an SSM document and EventBridge Scheduler.
 */
export class MongoDbInstanceWithBackup extends Construct {
  public readonly instance: Instance;
  public readonly securityGroup: SecurityGroup;
  public readonly credentials: Secret;
  public readonly backupBucket?: Bucket;
  public readonly ssmDocument?: CfnDocument;

  constructor(scope: Construct, id: string, props: MongoDbInstanceWithBackupProps) {
    super(scope, id);

    //EC2 Security Group
    this.securityGroup = new SecurityGroup(this, 'MongoDbInstanceSG', {
      vpc: props.vpc,
      description: 'Security Group for EC2 instance hosting MongoDB',
      allowAllOutbound: true, // Allow outbound connections for updates, S3 uploads, etc.
    });

    // Allow SSH access (port 22)
    this.securityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(22),
      'Allow SSH access from anywhere (restrict in production!)'
    );

    // IAM Role for EC2 with EC2 full access (for demonstration) and registered to SSM (SSM Agent available)
    const ec2Role = new Role(this, 'MongoEc2Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      ]
    });
    ec2Role.addToPolicy(new PolicyStatement({
      actions: ['ec2:*'],
      resources: ['*']
    }));

    //User Data for EC2 Instance to initialize with SSM and MongoDB (+1 year old)
    const initScript = 'userdata.sh';
    const userDataContent = readFileSync(initScript, 'utf-8');

    //EC2 Instance Provisioning ---
    this.instance = new Instance(this, 'MongoDbEC2Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnets: [props.vpcSubnet] },
      instanceType: props.instanceType,
      machineImage: props.machineImage,
      securityGroup: this.securityGroup,
      userData: UserData.custom(userDataContent),
      role: ec2Role,
    });

    // Create a secret in AWS Secrets Manager
    this.credentials = new Secret(this, "MongoDBCredentials",
    {
      secretName: "mongodb/credentials",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "dbAdmin"}),
        generateStringKey: "password",
        excludePunctuation: true,
        includeSpace: false,
      }
    });
    // Grant the EC2 instance access to the mongodb secret
    this.credentials.grantRead(ec2Role);

    // --- 4. Optional Backup Resources ---
    if (props.backupConfig) {
      if (!props.backupConfig.scheduleExpression) {
        throw new Error('backupScheduleExpression is required when backup is configured.');
      }

      // S3 Bucket for backups (public read and list)
      this.backupBucket = new Bucket(this, 'MongoBackupBucket', {
        blockPublicAccess: {
          blockPublicAcls: false,
          blockPublicPolicy: false,
          ignorePublicAcls: false,
          restrictPublicBuckets: false
        },
        cors: [
          {
            allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
            allowedOrigins: ['*'],
          },
        ],
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true // For demo only
      });
      this.backupBucket.grantWrite(ec2Role);  //TODO to remove
      this.backupBucket.grantRead(new AnyPrincipal());

      // Grant SSM permissions to access the S3 bucket
      const ssmAutomationRole = new Role(this, "SSMAutomationRole", {
        assumedBy: new ServicePrincipal('ssm.amazonaws.com'),
        description: 'IAM role that SSM Automation assumes to perform MongoDB backups',
      });
      ssmAutomationRole.addToPolicy(new PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: ['*'] //TODO change for specific instance id
      }));
      this.backupBucket.grantReadWrite(ssmAutomationRole);

      const automationFileContent = readFileSync('backup-document.json', 'utf-8');
      let documentContentJson = JSON.parse(automationFileContent);
      
      this.ssmDocument = new CfnDocument(this, 'MongoDBBackupSSMDoc', {
        name: `MongoDB-S3-Backup-Document-${cdk.Aws.STACK_NAME}`,
        content: documentContentJson,
        documentType: 'Automation',
        documentFormat: 'JSON',
        tags: [{ key: 'Purpose', value: 'MongoDBBackup' }]
      });

      // EventBridge Scheduler to Trigger SSM Document ---
      // IAM Role for EventBridge Scheduler to start SSM Automation Execution
      const schedulerRole = new Role(this, 'EventBridgeSchedulerSSMRole', {
        assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
        description: 'IAM role for EventBridge Scheduler to start SSM Automation',
      });
      
      // Grant permissions for the scheduler role to start SSM Automation executions
      schedulerRole.addToPolicy(
        new PolicyStatement({
          actions: ['ssm:StartAutomationExecution'],
          resources: [
            `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:automation-definition/${this.ssmDocument.name}:$DEFAULT`,
            `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:automation-execution/*`
          ],
        }),
      );
      schedulerRole.addToPolicy(
        new PolicyStatement({
          actions: ['ssm:*'],
          resources: [
            `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`,
          ],
        }),
      );
      schedulerRole.addToPolicy(
        new PolicyStatement({
          actions: ['ssm:SendCommand'],
          resources: [
            `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:instance/${this.instance.instanceId}`,
            `arn:aws:ssm:${cdk.Aws.REGION}::document/AWS-RunShellScript`
          ],
        }),
      );

      // Create the EventBridge Scheduler schedule
      new CfnSchedule(this, 'MongoDBS3BackupSchedule', {
        flexibleTimeWindow: { mode: 'FLEXIBLE', maximumWindowInMinutes: 5 }, // Flexible window for execution
        scheduleExpression: props.backupConfig.scheduleExpression,
        scheduleExpressionTimezone: props.backupConfig.scheduleTimezone || 'UTC',
        target: {
          arn: 'arn:aws:scheduler:::aws-sdk:ssm:startAutomationExecution',
          roleArn: schedulerRole.roleArn,
          // Input parameters for the SSM Automation Document
          input: JSON.stringify({
            DocumentName: this.ssmDocument.name,
            Parameters: {
              InstanceId: [this.instance.instanceId],
              AutomationAssumeRole: [ssmAutomationRole.roleArn],
              S3BucketName: [this.backupBucket.bucketName],
              Region: [cdk.Aws.REGION]
            }
          }),
        },
        state: 'ENABLED', // Ensure the schedule is enabled
      });
    }
  }
}
