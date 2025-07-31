import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { CfnAnalyzer } from 'aws-cdk-lib/aws-accessanalyzer';
import { Trail } from 'aws-cdk-lib/aws-cloudtrail';
import { CfnConfigurationRecorder, CfnDeliveryChannel, ManagedRule, ManagedRuleIdentifiers, ResourceType, RuleScope } from 'aws-cdk-lib/aws-config';
import { CfnServiceLinkedRole, Effect, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Setup CloudTrail for the account for audit purposes
 * Configure AWS Config to continuously monitor resources.
 * It adds rules to detect
 *  - SSH public access
 *  - S3 public access 
 */
export class AccountSecurityStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const trailLogBucket = new Bucket(this, 'SampleCloudTrailLogsBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL
    });

    const myTrail = new Trail(this, 'SampleTrail', {
      bucket: trailLogBucket,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      sendToCloudWatchLogs: true
    });

    const configRole = new Role(this, 'ConfigRecorderRole', {
      assumedBy: new ServicePrincipal('config.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWS_ConfigRole'),
      ],
    });

    const configRecorder = new CfnConfigurationRecorder(this, 'SampleConfigRecorder', {
      name: 'default',
      roleArn: configRole.roleArn,
      recordingGroup: {
        allSupported: true,
        includeGlobalResourceTypes: true
      },
    });

    const configBucket = new Bucket(this, 'ConfigBucket', {
      encryption: BucketEncryption.S3_MANAGED
    });

    // Attaches the AWSConfigBucketPermissionsCheck policy statement.
    configBucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [configRole],
      resources: [configBucket.bucketArn],
      actions: ['s3:GetBucketAcl'],
    }));

    // Attaches the AWSConfigBucketDelivery policy statement.
    configBucket.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [configRole],
      resources: [configBucket.arnForObjects(`AWSLogs/${Stack.of(this).account}/Config/*`)],
      actions: ['s3:PutObject'],
      conditions: {
        StringEquals: {
          's3:x-amz-acl': 'bucket-owner-full-control',
        }
      }
    }));

    new CfnDeliveryChannel(this, 'ConfigDeliveryChannel', {
      s3BucketName: configBucket.bucketName,      
    });    

    const s3PublicReadRule = new ManagedRule(this, 'S3BucketPublicReadProhibited', {
      identifier: ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_READ_PROHIBITED,
      description: 'Checks if S3 buckets are publicly readable.',
      ruleScope: RuleScope.fromResource(ResourceType.S3_BUCKET),
    });
    s3PublicReadRule.node.addDependency(configRecorder);


    const sshRule = new ManagedRule(this, 'RestrictedSSH', {
      identifier: ManagedRuleIdentifiers.EC2_SECURITY_GROUPS_INCOMING_SSH_DISABLED,
      description: 'Checks whether security groups are configured to restrict unrestricted incoming SSH traffic.',
      ruleScope: RuleScope.fromResource(ResourceType.EC2_SECURITY_GROUP),
    });
    sshRule.node.addDependency(configRecorder);
    
    new CfnOutput(this, 'CloudTrailBucketName', {
      value: trailLogBucket.bucketName,
      description: 'S3 Bucket where CloudTrail stores logs',
    });
    
    new CfnOutput(this, 'AWSConfigBucketName', {
      value: configBucket.bucketName,
      description: 'S3 Bucket where AWS Config stores configuration data and snapshots',
    });

  }
}