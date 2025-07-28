import {
  CfnOutput,
  Duration,
  Stack,
  StackProps,
  Tags
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Conditions,
  IManagedPolicy,
  OpenIdConnectProvider,
  PolicyDocument,
  Role,
  WebIdentityPrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Repository } from 'aws-cdk-lib/aws-ecr';

export interface GithubActionsRepositoryConfig {
  readonly owner: string;
  readonly repo: string;
  readonly filter?: string;
}

export interface GithubActionsRoleConfig {
  readonly inlinePolicies?: Record<string, PolicyDocument>;
  readonly managedPolicies?: IManagedPolicy[];
}

export interface GithubActionsOIDCStackProps extends StackProps {
  readonly repositoryConfig: GithubActionsRepositoryConfig;
  readonly roleConfig: GithubActionsRoleConfig;
}

export class GithubActionsOIDCStack extends Stack {
  
  public readonly role: Role;
  
  constructor(scope: Construct, id: string, props: GithubActionsOIDCStackProps) {
    super(scope, id, props);

    const githubProvider = new OpenIdConnectProvider(this, 'GithubActionsProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const iamRepoDeployAccess = `repo:${props.repositoryConfig.owner}/${props.repositoryConfig.repo}:${props.repositoryConfig.filter ?? '*'}`

    const conditions: Conditions = {
      StringLike: {
        'token.actions.githubusercontent.com:sub': iamRepoDeployAccess,
      },
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      },
    };

    this.role = new Role(this, 'GitHubActionsOidcAccessRole', {
      roleName: 'GitHubActionsOidcAccessRole',
      assumedBy: new WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, conditions),
      inlinePolicies: props.roleConfig.inlinePolicies,
      managedPolicies: props.roleConfig.managedPolicies,
      description: 'This role is used via GitHub Actions assume the role in the target AWS account',
      maxSessionDuration: Duration.hours(12),
    });

    //Create ECR Repository
    const repo = new Repository(this, 'SampleAppRepo');

    new CfnOutput(this, 'GitHubActionsOidcAccessRoleArn', {
      value: this.role.roleArn,
      description: `Arn for AWS IAM role with Github Actions OIDC auth for ${iamRepoDeployAccess}`,
      exportName: 'GitHubActionsOidcAccessRoleArn',
    });

    new CfnOutput(this, 'ECRRepositoryName', {
        value: repo.repositoryName,
        description: 'Name of the ECR Repository to store application docker images',
        exportName: 'ECRRepositoryName'
    })

    Tags.of(this).add('component', 'CdkGithubActionsOidcIamRole');
  }
}