#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PolicyDocument, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { GithubActionsOIDCStack } from '../lib/github-actions-oidc-stack';
import { InfraStack } from '../lib/infra-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const githubActions = new GithubActionsOIDCStack(app, 'GithubActionsOIDCStack', {
    env,
    repositoryConfig: {
      owner: 'vitodegiosa',
      repo: 'aws-k8s-mongodb-app',
    },
    roleConfig: {
      inlinePolicies: {
        AssumeCdkRolePolicy: new PolicyDocument({
          statements: [new PolicyStatement({
            actions: ['sts:AssumeRole'],
            resources: [`arn:aws:iam::${env.account}:role/cdk-*`],
          })],
        }),
        EcrPolicy: new PolicyDocument({
            statements:[new PolicyStatement({
                actions: ['ecr:*'],
                resources: [`arn:aws:ecr:${env.region}:${env.account}:*`]
            })]
        }),
        EKSPolicy: new PolicyDocument({
            statements:[
              new PolicyStatement({
                actions: ['eks:DescribeCluster', 'eks:ListClusters'],
                resources: [`*`]
              })
            ]
        })
      },
    },
});
new InfraStack(app, 'InfraStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
  githubActionsRole: githubActions.role
});