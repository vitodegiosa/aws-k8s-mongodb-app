import * as cdk from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType, MachineImage, Peer, Port, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { KubectlV32Layer } from '@aws-cdk/lambda-layer-kubectl-v32';
import { AccessEntry, AccessEntryType, AccessPolicy, AccessScopeType, Cluster, DefaultCapacityType, KubernetesVersion } from '@aws-cdk/aws-eks-v2-alpha';
import { MongoDbInstanceWithBackup } from './mongodb-instance';
import { ManagedPolicy, Role } from 'aws-cdk-lib/aws-iam';

export interface InfraStackProps extends cdk.StackProps {
  githubActionsRole: Role
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
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
      }
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
      release: 'secrets-store-csi-driver-provider-aws', // Helm release name
      repository: 'https://aws.github.io/secrets-store-csi-driver-provider-aws',
      namespace: 'kube-system',
      version: '1.0.1',
      wait: true,
      values: {
        rotationPollInterval: '30s', // How often to check Secrets Manager for updates
      }
    });
    //awsProviderChart.node.addDependency(csiDriverChart);

    const appServiceAccount = cluster.addServiceAccount('SampleAppServiceAccount', {
      name: 'sample-app-sa',
      namespace: 'default'
    });

    const clusterRoleBinding = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: {
        name: 'sample-app-sa-cluster-admin-binding'
      },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: appServiceAccount.serviceAccountName,
          namespace: appServiceAccount.serviceAccountNamespace
        }
      ],
      roleRef: {
        kind: 'ClusterRole',
        name: 'cluster-admin',
        apiGroup: 'rbac.authorization.k8s.io'
      }
    };
    cluster.addManifest('SampleAppSAClusterRoleBinding', clusterRoleBinding);

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

    const appLabels = { app: 'sample-app' };

    // Kubernetes Deployment
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'sample-app' },
      spec: {
        replicas: 1,
        selector: { matchLabels: appLabels },
        template: {
          metadata: { labels: appLabels },
          spec: {
            serviceAccountName: appServiceAccount.serviceAccountName,
            containers: [
              {
                name: 'sample-app',
                image: '242201275059.dkr.ecr.us-east-1.amazonaws.com/githubactionsoidcstack-sampleapprepod40c970d-lkhwlwklf0xw:initial',
                ports: [{ containerPort: 8080 }],
                env: [
                  // Retrieve individual components from the synced Kubernetes Secret
                  {
                    name: 'MONGODB_USERNAME',
                    valueFrom: {
                      secretKeyRef: {
                        name: 'mongodb-individual-components-synced', // Reference the synced K8s Secret
                        key: 'username',
                      },
                    },
                  },
                  {
                    name: 'MONGODB_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: 'mongodb-individual-components-synced',
                        key: 'password',
                      },
                    },
                  },
                  {
                    name: 'MONGODB_HOST',
                    value: 'mongodb-external.default.svc.cluster.local:27017/?authSource=admin'
                  },
                  {
                    name: 'SECRET_KEY',
                    value: `secret123` // This should also live in secrets manager
                  },
                ],
                volumeMounts: [{
                  name: 'secrets-store-inline',
                  mountPath: '/mnt/secrets-store',
                  readOnly: true,
                }],
              },
            ],
            volumes: [{
              name: 'secrets-store-inline',
              csi: {
                driver: 'secrets-store.csi.k8s.io',
                readOnly: true,
                volumeAttributes: {
                  secretProviderClass: 'mongodb-secretprovider',
                },
              },
            }]
          },
        },
      },
    };

    // Kubernetes Service (NodePort for ALB)
    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'sample-app-service' },
      spec: {
        selector: appLabels,
        ports: [{ port: 80, targetPort: 8080 }],
        type: 'NodePort',
      },
    };

    const ingress = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: 'sample-app-ingress',
        annotations: {
          //'kubernetes.io/ingress.class': 'alb',
          'alb.ingress.kubernetes.io/scheme': 'internet-facing',
          'alb.ingress.kubernetes.io/target-type': 'ip',
          //'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP": 80}]',
        },
      },
      spec: {
        ingressClassName: 'alb',
        rules: [
          {
            http: {
              paths: [
                {
                  path: '/',
                  pathType: 'Prefix',
                  backend: {
                    service: {
                      name: 'sample-app-service',
                      port: { number: 80 },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    };

    // Add resources to the cluster
    //cluster.addManifest('AppIngressClass', ingressClass);
    cluster.addManifest('AppDeployment', deployment);
    cluster.addManifest('AppService', service);
    cluster.addManifest('AppIngress', ingress);

    //Give Github Actions access to perform deployment by updating the container image
    const accessEntry = new AccessEntry(this, 'GitHubActionsEksAccessEntry', {
      cluster: cluster,
      principal: props.githubActionsRole.roleArn,
      accessEntryType: AccessEntryType.STANDARD,
      //kubernetesGroups: [k8sAccessGroupName], // This is the Kubernetes group name
      // You can also attach EKS-managed access policies directly here if they fit your needs
      accessPolicies: [
        AccessPolicy.fromAccessPolicyName('AmazonEKSAdminPolicy', { accessScopeType: AccessScopeType.CLUSTER}),
        AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', { accessScopeType: AccessScopeType.CLUSTER})
      ]
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

    //Output the EKS Cluster name
    new cdk.CfnOutput(this, 'EksClusterName', {
      value: cluster.clusterName,
      description: "Name of the EKS Cluster"
    });
  }
}
