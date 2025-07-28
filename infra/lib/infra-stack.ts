import * as cdk from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType, MachineImage, Peer, Port, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
import { Cluster, DefaultCapacityType, KubernetesVersion } from '@aws-cdk/aws-eks-v2-alpha';
import { MongoDbInstanceWithBackup } from './mongodb-instance';
import { ManagedPolicy } from 'aws-cdk-lib/aws-iam';

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

    const cluster = new Cluster(this, 'EksCluster', {
      version: KubernetesVersion.V1_32,
      vpc,
      vpcSubnets: [{ subnetType: SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacityType: DefaultCapacityType.AUTOMODE, // default value
      kubectlProviderOptions: {
        kubectlLayer: new KubectlV32Layer(this, 'kubectl'),
      }/*,
      albController: {
        version: eksv2.AlbControllerVersion.V2_8_2
      }*/
    });
    mongoDBInstance.securityGroup.addIngressRule(Peer.securityGroupId(cluster.clusterSecurityGroupId), Port.tcp(27017), 'MongoDB from EKS Nodes');

    const csiDriverChart = cluster.addHelmChart('SecretsStoreCsiDriver', {
      chart: 'secrets-store-csi-driver',
      release: 'csi-secrets-store', // Helm release name
      repository: 'https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts',
      namespace: 'kube-system',
      wait: true, // Wait for the chart to be deployed
      values: {
        syncSecret: {
          enabled: true // Enable syncing secrets to native Kubernetes Secrets
        }
      },
    });

    // Helm chart for the AWS specific provider
    const awsProviderChart = cluster.addHelmChart('AwsSecretsProvider', {
      chart: 'secrets-store-csi-driver-provider-aws',
      release: 'secrets-provider-aws', // Helm release name
      repository: 'https://aws.github.io/secrets-store-csi-driver-provider-aws',
      namespace: 'kube-system',
      wait: true,
      values: {
        rotationPollInterval: '30s', // How often to check Secrets Manager for updates
        serviceAccount: {
          create: true
        }
      }
    });
    awsProviderChart.node.addDependency(csiDriverChart);

    const appServiceAccount = cluster.addServiceAccount('SampleAppServiceAccount', {
      name: 'sample-app-sa',
      namespace: 'default'
    });

    // Grant Cluster admin permissions to the application pod via service account
    appServiceAccount.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'));
    appServiceAccount.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSVPCResourceController'));

    // Grant the Service Account permissions to read the secret
    mongoDBInstance.credentials.grantRead(appServiceAccount);

    const secretProviderClassManifest = cluster.addManifest('MongoDBSecretProviderClass', {
      apiVersion: 'secrets-store.csi.x-k8s.io/v1',
      kind: 'SecretProviderClass',
      metadata: {
        name: 'mongodb-secretprovider',
        namespace: 'default',
      },
      spec: {
        provider: 'aws',
        parameters: {
          // This must be a string representing the JSON of the 'objects' array.
          // Directly define the JS object and then stringify it.
          objects: JSON.stringify([
            {
              objectName: mongoDBInstance.credentials.secretName, // Name of your secret in Secrets Manager
              objectType: "secretsmanager",
              jmesPath: [
                { path: "username", objectAlias: "username" },
                { path: "password", objectAlias: "password" }
              ],
            },
          ]),
        },
        secretObjects: [
          {
            secretName: 'mongodb-individual-components-synced',
            type: 'Opaque',
            data: [
              { objectName: 'username', key: 'username' },
              { objectName: 'password', key: 'password' }
            ],
          },
        ],
      },
    });
    secretProviderClassManifest.node.addDependency(appServiceAccount);

    const mongoService = {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: "mongodb-external",
        namespace: "default"
      },
      spec: {
        type: "ExternalName",
        externalName: mongoDBInstance.instance.instancePrivateDnsName,
        ports: [
          {
            protocol: "TCP",
            port: 27017,
            targetPort: 27017
          }
        ]
      }
    }
    cluster.addManifest("MongoService", mongoService);

    const ingressClass = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'IngressClass',
        metadata: {
            labels: {
                'app.kubernetes.io/name': 'LoadBalancerController',
            },
            name: 'alb'
        },
        spec: {
            controller: 'eks.amazonaws.com/alb'
        }
    }
    cluster.addManifest('AppIngressClass', ingressClass);

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

    //Output the EKS Cluster name
    new cdk.CfnOutput(this, 'EksClusterName', {
      value: cluster.clusterName,
      description: "Name of the EKS Cluster"
    });
  }
}
